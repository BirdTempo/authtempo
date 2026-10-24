import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

/** The address of a test user that has one (plan 12i): a user can have no address, so a read checks it. */
function emailOf(user: { email: string | null }): string {
  if (user.email === null) throw new Error("the test user has no address");
  return user.email;
}

const DAY = 86_400_000;

/** A signed-in cookie session through the magic link, so the session tests start signed in. */
async function signedIn(
  server: ReturnType<typeof makeServer>,
  wrap: (f: typeof fetch) => typeof fetch = (f) => f,
) {
  const { fetch, jar } = inProcessFetch(server.auth);
  const client = createClient({ baseURL: BASE_URL, fetch: wrap(fetch) });
  const req = await client.magicLink.request({ email: "ada@example.com" });
  if (!req.ok) throw new Error(req.code);
  const token = tokenFromMail(server.mail[0]?.text ?? "");
  const v = await client.magicLink.verify({ token });
  if (!v.ok) throw new Error(v.code);
  if ("twoFactor" in v.value) throw new Error("no session: a second-factor challenge");
  return { client, jar, session: v.value };
}

describe("session and sign-out", () => {
  it("answers null with no session, the session with a cookie, and null again after sign-out", async () => {
    const server = makeServer();
    const anon = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await anon.session()).toEqual({ ok: true, value: null });
    const { client, jar } = await signedIn(server);
    expect(jar.size).toBe(1);
    const s = await client.session();
    expect(s.ok && s.value?.user.email).toBe("ada@example.com");
    expect(await client.signOut()).toEqual({ ok: true, value: { ok: true } });
    expect(jar.size).toBe(0);
    expect(await client.session()).toEqual({ ok: true, value: null });
  });

  it("reaches the session with a bearer token and no cookie", async () => {
    const server = makeServer();
    const { session } = await signedIn(server);
    // A second client with no cookie jar: the bearer token is the whole session.
    const bearer = await bearerFor(server, emailOf(session.user));
    const native = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      credentials: "omit",
      token: () => bearer,
    });
    const s = await native.session();
    expect(s.ok && s.value?.user.email).toBe("ada@example.com");
  });

  it("reads needsRefresh with session.deferRefresh on, and slides the expiry by session.refresh", async () => {
    const server = makeServer({ session: { deferRefresh: true } });
    const { client, jar } = await signedIn(server);
    const first = await client.session();
    expect(first.ok && first.value?.needsRefresh).toBe(false);
    const before = first.ok ? first.value?.session.expiresAt : undefined;
    // The store reads once now, before the refresh is due.
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().data?.session.expiresAt).toBe(before));
    server.clock.advance(8 * DAY);
    const due = await client.session();
    expect(due.ok && due.value?.needsRefresh).toBe(true);
    expect(due.ok && due.value?.session.expiresAt).toBe(before);
    const cookie = [...jar.values()][0];
    const r = await client.session.refresh();
    const moved = new Date(server.clock.now().getTime() + 30 * DAY).toISOString();
    expect(r.ok && r.value?.session.expiresAt).toBe(moved);
    // The refresh renews the cookie; the token stays the same.
    expect([...jar.values()]).toEqual([cookie]);
    // The store reads again after the refresh.
    await vi.waitFor(() => expect(client.store.get().data?.session.expiresAt).toBe(moved));
    stop();
    const after = await client.session();
    expect(after.ok && after.value?.needsRefresh).toBe(false);
  });

  it("keeps a session alive for ten days by the store's read alone, with one refresh per due day", async () => {
    const server = makeServer({ session: { deferRefresh: true } });
    // Count the refresh posts: a store that posts on every read must fail (fix wave, Task 17 R2-L1).
    let posts = 0;
    const { client } = await signedIn(server, (f) => async (input, init) => {
      const req = new Request(input, init);
      if (req.method === "POST" && new URL(req.url).pathname === "/auth/session/refresh") posts++;
      return f(req);
    });
    const slid: boolean[] = [];
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
    const before = await server.storage.findMany("session", []);
    expect(before).toHaveLength(1);
    for (let day = 1; day <= 10; day++) {
      // One read a day after the last slide: the refresh is not due, so no post and no slide.
      const [held] = await server.storage.findMany("session", []);
      server.clock.advance(DAY);
      await client.store.refetch();
      expect(posts, `day ${day * 8 - 7}`).toBe(day - 1);
      const [same] = await server.storage.findMany("session", []);
      expect(same?.expiresAt, `day ${day * 8 - 7}`).toEqual(held?.expiresAt);
      // Seven days later the refresh is due: one post.
      server.clock.advance(7 * DAY);
      await client.store.refetch();
      expect(posts, `day ${day * 8}`).toBe(day);
      const state = client.store.get();
      expect(state.data?.user.email, `day ${day * 8}`).toBe("ada@example.com");
      // The store holds the refresh's answer, so no refresh is due.
      expect(state.data?.needsRefresh, `day ${day * 8}`).toBeUndefined();
      const [row] = await server.storage.findMany("session", []);
      slid.push(row?.expiresAt.getTime() === server.clock.now().getTime() + 30 * DAY);
    }
    stop();
    // Each due read slid the row: 80 days past a 30-day session, the user is still in.
    expect(slid).toEqual(Array(10).fill(true));
    expect(posts).toBe(10);
  });

  it("keeps the GET answer in the store when the refresh fails", async () => {
    const due = { user: { id: "u1" }, session: { id: "s1" }, needsRefresh: true };
    const seen: string[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      broadcast: false,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return req.method === "GET"
          ? Response.json(due)
          : new Response("<html>bad gateway</html>", { status: 502 });
      }) as typeof fetch,
    });
    await client.store.refetch();
    expect(client.store.get()).toMatchObject({ data: due, error: null });
    expect(seen).toEqual(["GET /auth/session", "POST /auth/session/refresh"]);
  });

  it("reads the bearer token once per refresh, and ends a dead token as session() does", async () => {
    let reads = 0;
    const ended: string[] = [];
    const headers: (string | null)[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      credentials: "omit",
      token: () => `st_token${++reads}`,
      onSessionEnd: (sent) => {
        ended.push(sent);
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        headers.push(
          `${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization")}`,
        );
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }) as typeof fetch,
    });
    expect(await client.session.refresh()).toEqual({ ok: true, value: null });
    expect(reads).toBe(1);
    expect(headers).toEqual(["POST /auth/session/refresh Bearer st_token1"]);
    expect(ended).toEqual(["st_token1"]);
  });

  it("answers unexpected with the status for an answer that is not JSON (Review Focus 1)", async () => {
    const client = createClient({
      baseURL: BASE_URL,
      fetch: (async () =>
        new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch,
    });
    expect(await client.session()).toEqual({ ok: false, code: "unexpected", status: 502 });
  });
});

/** A bearer token for a user: the in-process api opens a session directly. */
async function bearerFor(server: ReturnType<typeof makeServer>, email: string): Promise<string> {
  const req = await server.auth.api.requestMagicLink({ email, ip: null });
  if (!req.ok) throw new Error(req.code);
  const token = tokenFromMail(server.mail.at(-1)?.text ?? "");
  const v = await server.auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!v.ok) throw new Error(v.code);
  if (!("token" in v.value)) throw new Error("the sign-in answered a challenge");
  return v.value.token;
}
