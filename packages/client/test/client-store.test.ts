import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { SESSION_CHANNEL } from "../src/store.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

async function signIn(
  server: ReturnType<typeof makeServer>,
  client: ReturnType<typeof createClient>,
) {
  const req = await client.magicLink.request({ email: "ada@example.com" });
  if (!req.ok) throw new Error(req.code);
  const v = await client.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
  if (!v.ok) throw new Error(v.code);
  return v.value;
}

describe("client.store (plan 11d)", () => {
  it("reads the session at the first subscriber, and again after a sign-in and a sign-out", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
    expect(client.store.get().data).toBeNull();
    await signIn(server, client);
    await vi.waitFor(() => expect(client.store.get().data?.user.email).toBe("ada@example.com"));
    await client.signOut();
    await vi.waitFor(() => expect(client.store.get().data).toBeNull());
    stop();
  });

  it("reads again after the active organization changes", async () => {
    const server = makeServer({ organizations: {} });
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    await signIn(server, client);
    const created = await client.organizations.create({ slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
    await client.organizations.setActive({ organizationId: created.value.organization.id });
    await vi.waitFor(() =>
      expect(client.store.get().data?.session.activeOrganizationId).toBe(
        created.value.organization.id,
      ),
    );
    stop();
  });

  it("tells the other tabs, and a store that hears the message reads again", async () => {
    const server = makeServer();
    // Two tabs of one browser: one cookie jar, two clients.
    const browser = inProcessFetch(server.auth);
    const tabA = createClient({ baseURL: BASE_URL, fetch: browser.fetch });
    const tabB = createClient({ baseURL: BASE_URL, fetch: browser.fetch });
    await signIn(server, tabA);
    const stop = tabB.store.subscribe(() => {});
    await vi.waitFor(() => expect(tabB.store.get().data?.user.email).toBe("ada@example.com"));
    await tabA.signOut();
    await vi.waitFor(() => expect(tabB.store.get().data).toBeNull());
    expect(SESSION_CHANNEL).toBe("authtempo-session");
    stop();
  });

  it("does not tell other tabs with broadcast off", async () => {
    const server = makeServer();
    const browser = inProcessFetch(server.auth);
    const tabA = createClient({ baseURL: BASE_URL, fetch: browser.fetch, broadcast: false });
    const tabB = createClient({ baseURL: BASE_URL, fetch: browser.fetch, broadcast: false });
    await signIn(server, tabA);
    const stop = tabB.store.subscribe(() => {});
    await vi.waitFor(() => expect(tabB.store.get().data?.user.email).toBe("ada@example.com"));
    await tabA.signOut();
    await new Promise((r) => setTimeout(r, 30));
    expect(tabB.store.get().data?.user.email).toBe("ada@example.com");
    stop();
  });

  it("runs onSessionEnd when a bearer client's session answers null", async () => {
    const server = makeServer();
    const r = await server.auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    if (!r.ok) throw new Error(r.code);
    const v = await server.auth.api.verifyMagicLink({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!v.ok) throw new Error(v.code);
    if (!("token" in v.value)) throw new Error("the sign-in answered a challenge");
    const issued = v.value.token;
    let token: string | null = issued;
    let ended = 0;
    const client = createClient({
      baseURL: BASE_URL,
      credentials: "omit",
      fetch: inProcessFetch(server.auth).fetch,
      token: () => token,
      onSessionEnd: () => {
        ended++;
        token = null;
      },
    });
    const live = await client.session();
    expect(live.ok && live.value?.user.email).toBe("ada@example.com");
    expect(ended).toBe(0);
    await client.signOut();
    // The token is dead on the server; the next read answers null and clears it.
    token = issued;
    expect(await client.session()).toEqual({ ok: true, value: null });
    expect(ended).toBe(1);
    expect(token).toBeNull();
  });
});

/** A live bearer token of ada, minted on the server. */
async function bearerToken(server: ReturnType<typeof makeServer>): Promise<string> {
  const r = await server.auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
  if (!r.ok) throw new Error(r.code);
  const v = await server.auth.api.verifyMagicLink({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
    ip: null,
    userAgent: null,
  });
  if (!v.ok) throw new Error(v.code);
  if (!("token" in v.value)) throw new Error("the sign-in answered a challenge");
  return v.value.token;
}

/** A fetch that counts the session reads. */
function countingSessions(fetch: typeof globalThis.fetch) {
  let reads = 0;
  const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname.endsWith("/session")) reads++;
    return fetch(req);
  }) as typeof globalThis.fetch;
  return { fetch: counted, reads: () => reads };
}

describe("client.store fix round (plan 11d Task 5 review)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens no channel and adds no document listener until the store gets a subscriber (J1)", async () => {
    const counts = { open: 0, closed: 0, posted: 0, listeners: 0 };
    class CountingChannel {
      constructor(readonly name: string) {
        counts.open++;
      }
      postMessage() {
        counts.posted++;
      }
      addEventListener() {}
      close() {
        counts.closed++;
      }
    }
    vi.stubGlobal("BroadcastChannel", CountingChannel);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {
        counts.listeners++;
      },
    });
    const server = makeServer();
    const fetch = inProcessFetch(server.auth).fetch;
    for (let i = 0; i < 10; i++) {
      const c = createClient({ baseURL: BASE_URL, fetch });
      await c.session();
      await c.signOut();
    }
    // Each sign-out told the other tabs through a short channel that it closed.
    expect(counts).toEqual({ open: 10, closed: 10, posted: 10, listeners: 0 });
    const c = createClient({ baseURL: BASE_URL, fetch });
    const stop1 = c.store.subscribe(() => {});
    const stop2 = c.store.subscribe(() => {});
    await vi.waitFor(() => expect(c.store.get().isPending).toBe(false));
    await c.signOut();
    // One listening channel for the store, which also posts; one document listener.
    expect(counts).toEqual({ open: 11, closed: 10, posted: 11, listeners: 1 });
    stop1();
    stop2();
  });

  it("runs onSessionEnd once per end, as the app clears the token (J2)", async () => {
    const server = makeServer();
    let token: string | null = await bearerToken(server);
    const issued = token;
    let ended = 0;
    const client = createClient({
      baseURL: BASE_URL,
      credentials: "omit",
      fetch: inProcessFetch(server.auth).fetch,
      token: () => token,
      onSessionEnd: () => {
        ended++;
        token = null;
      },
    });
    await client.signOut();
    token = issued;
    for (let i = 0; i < 3; i++) expect(await client.session()).toEqual({ ok: true, value: null });
    expect(ended).toBe(1);
  });

  it("ends the reads when onSessionEnd signs out or refetches the store (J2)", async () => {
    for (const inside of ["signOut", "refetch"] as const) {
      const server = makeServer();
      let token: string | null = await bearerToken(server);
      const issued = token;
      let ended = 0;
      const counting = countingSessions(inProcessFetch(server.auth).fetch);
      const client = createClient({
        baseURL: BASE_URL,
        credentials: "omit",
        fetch: counting.fetch,
        token: () => token,
        onSessionEnd: async () => {
          ended++;
          if (ended > 5) throw new Error("onSessionEnd runs with no end");
          token = null;
          if (inside === "signOut") await client.signOut();
          else void client.store.refetch();
        },
      });
      const stop = client.store.subscribe(() => {});
      await vi.waitFor(() => expect(client.store.get().data?.user.email).toBe("ada@example.com"));
      await client.signOut();
      token = issued;
      await client.store.refetch();
      await vi.waitFor(() => expect(client.store.get().isRefetching).toBe(false));
      await new Promise((r) => setTimeout(r, 20));
      expect(client.store.get().data).toBeNull();
      expect(ended).toBe(1);
      expect(counting.reads()).toBeLessThanOrEqual(5);
      stop();
    }
  });

  it("reads again when the page becomes visible, not while hidden, and not with the option off (M1)", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", doc);
    const server = makeServer();
    for (const refetchOnVisible of [true, false]) {
      const counting = countingSessions(inProcessFetch(server.auth).fetch);
      const client = createClient({
        baseURL: BASE_URL,
        fetch: counting.fetch,
        broadcast: false,
        refetchOnVisible,
      });
      const stop = client.store.subscribe(() => {});
      await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 10));
      expect(counting.reads()).toBe(1);
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 10));
      expect(counting.reads()).toBe(refetchOnVisible ? 2 : 1);
      stop();
    }
  });

  it("reads again after the active organization is deleted or its member leaves (M2)", async () => {
    for (const end of ["delete", "leave"] as const) {
      const server = makeServer({ organizations: {} });
      const client = createClient({
        baseURL: BASE_URL,
        fetch: inProcessFetch(server.auth).fetch,
        broadcast: false,
      });
      const ada = await signIn(server, client);
      if ("twoFactor" in ada) throw new Error("the sign-in answered a challenge");
      const created = await client.organizations.create({ slug: "acme", name: "Acme" });
      if (!created.ok) throw new Error(created.code);
      const organizationId = created.value.organization.id;
      await client.organizations.setActive({ organizationId });
      const stop = client.store.subscribe(() => {});
      await vi.waitFor(() =>
        expect(client.store.get().data?.session.activeOrganizationId).toBe(organizationId),
      );
      if (end === "delete") {
        const r = await client.organizations.delete({ organizationId });
        if (!r.ok) throw new Error(r.code);
      } else {
        // Core keeps one owner, so ada adds bo as a second owner before she leaves.
        const bo = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
        await bo.magicLink.request({ email: "bo@example.com" });
        const v = await bo.magicLink.verify({
          token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
        });
        if (!v.ok || "twoFactor" in v.value) throw new Error("bo did not sign in");
        const added = await client.organizations.members.add({
          organizationId,
          userId: v.value.user.id,
          role: "owner",
        });
        if (!added.ok) throw new Error(added.code);
        const r = await client.organizations.members.remove({
          organizationId,
          userId: ada.user.id,
        });
        if (!r.ok) throw new Error(r.code);
      }
      await vi.waitFor(() =>
        expect(client.store.get().data?.session.activeOrganizationId).toBeNull(),
      );
      stop();
    }
  });
});
