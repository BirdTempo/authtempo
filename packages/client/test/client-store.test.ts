import { describe, expect, it, vi } from "vitest";
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
