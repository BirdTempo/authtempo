import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const DAY = 86_400_000;

/** A signed-in cookie session through the magic link, so the session tests start signed in. */
async function signedIn(server: ReturnType<typeof makeServer>) {
  const { fetch, jar } = inProcessFetch(server.auth);
  const client = createClient({ baseURL: BASE_URL, fetch });
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
    const bearer = await bearerFor(server, session.user.email);
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
    server.clock.advance(8 * DAY);
    const due = await client.session();
    expect(due.ok && due.value?.needsRefresh).toBe(true);
    expect(due.ok && due.value?.session.expiresAt).toBe(before);
    const cookie = [...jar.values()][0];
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().data?.needsRefresh).toBe(true));
    const r = await client.session.refresh();
    expect(r.ok && r.value?.session.expiresAt).toBe(
      new Date(server.clock.now().getTime() + 30 * DAY).toISOString(),
    );
    // The refresh renews the cookie; the token stays the same.
    expect([...jar.values()]).toEqual([cookie]);
    // The store reads again after the refresh.
    await vi.waitFor(() => expect(client.store.get().data?.needsRefresh).toBe(false));
    stop();
    const after = await client.session();
    expect(after.ok && after.value?.needsRefresh).toBe(false);
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
