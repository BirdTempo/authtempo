import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import {
  createOAuthClient,
  memoryPendingStore,
  OAUTH_CALLS,
  PENDING_TTL_MS,
  registerOAuthClient,
} from "../src/oauth/index.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const ISSUER = `${BASE_URL}/auth`;
const RESOURCE = `${BASE_URL}/mcp`;
const REDIRECT = "http://127.0.0.1:8123/callback";

/** A server with the provider on, a signed-in browser, and a native client registered through the route. */
async function setup(scopes: readonly string[] = ["openid", "offline_access"]) {
  const server = makeServer({ oauth: { resources: [RESOURCE], registration: { cimd: false } } });
  const browser = inProcessFetch(server.auth);
  const person = createClient({ baseURL: BASE_URL, fetch: browser.fetch });
  await person.magicLink.request({ email: "ada@example.com" });
  const v = await person.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
  if (!v.ok) throw new Error(v.code);
  // The native app: no Origin header, no cookie.
  const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    server.auth.handle(new Request(input, init))) as typeof fetch;
  const reg = await registerOAuthClient({
    issuer: ISSUER,
    clientName: "CLI",
    redirectUris: [REDIRECT],
    fetch: appFetch,
  });
  if (!reg.ok) throw new Error(reg.code);
  const oauth = createOAuthClient({
    issuer: ISSUER,
    clientId: reg.value.clientId,
    redirectUri: REDIRECT,
    resource: RESOURCE,
    scopes,
    fetch: appFetch,
    clock: server.clock,
  });
  /** The person's browser opens the authorize URL and allows; answers the URL the app gets back. */
  async function consent(url: string): Promise<string> {
    const page = await browser.fetch(url);
    if (page.status !== 200) throw new Error(`authorize answered ${page.status}`);
    const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    const cookie = [...browser.jar].map(([k, val]) => `${k}=${val}`).join("; ");
    // The consent form posts from the API's own origin.
    const done = await server.auth.handle(
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE_URL,
          cookie,
        },
        body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
      }),
    );
    return done.headers.get("location") ?? "";
  }
  return { server, oauth, consent, appFetch, clientId: reg.value.clientId };
}

describe("the OAuth client (plan 11d)", () => {
  it("lists only routes of the provider", () => {
    expect(OAUTH_CALLS.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /.well-known/oauth-authorization-server",
      "GET /oauth/authorize",
      "POST /oauth/token",
      "POST /oauth/revoke",
      "POST /oauth/register",
      "GET /oauth/userinfo",
    ]);
  });

  it("signs in with PKCE, refreshes, reads userinfo, and revokes", async () => {
    const { server, oauth, consent } = await setup();
    const url = await oauth.authorizeURL();
    if (!url.ok) throw new Error(url.code);
    const q = new URL(url.value).searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(RESOURCE);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tokens = await oauth.handleRedirect(await consent(url.value));
    if (!tokens.ok) throw new Error(tokens.code);
    expect(tokens.value.tokenType).toBe("Bearer");
    expect(tokens.value.scopes).toEqual(["openid", "offline_access"]);
    expect(tokens.value.refreshToken).toMatch(/^or_/);
    expect(tokens.value.idToken).toBeTypeOf("string");
    expect(tokens.value.expiresAt.getTime()).toBeGreaterThan(server.clock.now().getTime());
    const caller = await server.auth.caller(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${tokens.value.accessToken}` } }),
    );
    expect(caller?.kind).toBe("oauth");
    const info = await oauth.userinfo(tokens.value.accessToken);
    expect(info.ok && typeof info.value.sub).toBe("string");
    const next = await oauth.refresh(tokens.value.refreshToken ?? "");
    if (!next.ok) throw new Error(next.code);
    expect(next.value.refreshToken).not.toBe(tokens.value.refreshToken);
    expect(await oauth.revoke(next.value.refreshToken ?? "")).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(await oauth.refresh(next.value.refreshToken ?? "")).toEqual({
      ok: false,
      code: "invalid_grant",
      status: 400,
    });
  });

  it("answers redirect_mismatch for an unknown state, a used state, another iss, and another redirect", async () => {
    const { oauth, consent } = await setup(["openid"]);
    const url = await oauth.authorizeURL();
    if (!url.ok) throw new Error(url.code);
    const back = await consent(url.value);
    const changed = (k: string, v: string) => {
      const u = new URL(back);
      u.searchParams.set(k, v);
      return u.toString();
    };
    const mismatch = { ok: false, code: "redirect_mismatch", status: 0 };
    expect(await oauth.handleRedirect(changed("state", "x".repeat(43)))).toEqual(mismatch);
    expect(await oauth.handleRedirect(changed("iss", "https://evil.example.net/auth"))).toEqual(
      mismatch,
    );
    expect(await oauth.handleRedirect(back.replace("127.0.0.1:8123", "127.0.0.1:9999"))).toEqual(
      mismatch,
    );
    expect((await oauth.handleRedirect(back)).ok).toBe(true);
    expect(await oauth.handleRedirect(back)).toEqual(mismatch);
  });

  it("answers the provider's error of a redirect with status 0, and refuses a pending sign-in older than 10 minutes", async () => {
    const { server, oauth } = await setup(["openid"]);
    const url = await oauth.authorizeURL();
    if (!url.ok) throw new Error(url.code);
    const state = new URL(url.value).searchParams.get("state") ?? "";
    const denied = `${REDIRECT}?error=access_denied&state=${state}&iss=${encodeURIComponent(ISSUER)}`;
    expect(await oauth.handleRedirect(denied)).toEqual({
      ok: false,
      code: "access_denied",
      status: 0,
    });
    const late = await oauth.authorizeURL();
    if (!late.ok) throw new Error(late.code);
    server.clock.advance(10 * 60_000 + 1);
    const lateState = new URL(late.value).searchParams.get("state") ?? "";
    expect(
      await oauth.handleRedirect(
        `${REDIRECT}?code=oc_x&state=${lateState}&iss=${encodeURIComponent(ISSUER)}`,
      ),
    ).toEqual({ ok: false, code: "redirect_mismatch", status: 0 });
  });

  it("refuses a wrong config at construction", () => {
    const base = {
      issuer: ISSUER,
      clientId: "cl_x",
      redirectUri: REDIRECT,
      resource: RESOURCE,
      scopes: ["openid"],
    };
    expect(() => createOAuthClient({ ...base, issuer: "not a url" })).toThrow(/issuer/);
    expect(() => createOAuthClient({ ...base, issuer: `${ISSUER}?x=1` })).toThrow(/issuer/);
    expect(() => createOAuthClient({ ...base, scopes: [] })).toThrow(/scopes/);
    expect(() => createOAuthClient({ ...base, redirectUri: "" })).toThrow(/redirectUri/);
  });
});

/** An OAuth client on a stub fetch that answers `answer()` and keeps each request. */
function stub(
  answer: () => Response,
  extra: Partial<Parameters<typeof createOAuthClient>[0]> = {},
) {
  const sent: Request[] = [];
  const fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(i, init));
    return answer();
  }) as typeof globalThis.fetch;
  const oauth = createOAuthClient({
    issuer: ISSUER,
    clientId: "cl_a",
    redirectUri: REDIRECT,
    resource: RESOURCE,
    scopes: ["openid", "offline_access"],
    fetch,
    ...extra,
  });
  return { oauth, sent, fetch };
}

/** Starts a sign-in, then hands back a redirect with its state, the issuer, and `params`. */
async function redirectWith(
  oauth: ReturnType<typeof createOAuthClient>,
  params: Record<string, string>,
) {
  const u = await oauth.authorizeURL();
  if (!u.ok) throw new Error(u.code);
  const state = new URL(u.value).searchParams.get("state") ?? "";
  const q = new URLSearchParams({ state, iss: ISSUER, ...params });
  return oauth.handleRedirect(`${REDIRECT}?${q}`);
}

const GOOD = { access_token: "oa_x", token_type: "Bearer", expires_in: 3600, scope: "openid" };

describe("the OAuth client's answers and rules (plan 11d Task 8 review)", () => {
  it("answers unexpected for a token answer of a wrong shape, and never throws", async () => {
    const wrong: unknown[] = [
      {},
      null,
      [],
      "s",
      { error: "invalid_grant" },
      { ...GOOD, token_type: "mac" },
      { ...GOOD, expires_in: "x" },
      { ...GOOD, expires_in: -1 },
      { ...GOOD, access_token: 5 },
      { ...GOOD, access_token: "" },
      { ...GOOD, scope: 5 },
      { ...GOOD, refresh_token: 5 },
      { ...GOOD, id_token: 5 },
    ];
    for (const body of wrong) {
      const { oauth } = stub(() => Response.json(body));
      const unexpected = { ok: false, code: "unexpected", status: 200 };
      expect(await redirectWith(oauth, { code: "oc_x" })).toEqual(unexpected);
      expect(await oauth.refresh("or_x")).toEqual(unexpected);
    }
  });

  it("reads a lower-case bearer, and takes the asked scopes when the answer has none", async () => {
    const { oauth } = stub(() =>
      Response.json({ access_token: "oa_x", token_type: "bearer", expires_in: 60 }),
    );
    const r = await redirectWith(oauth, { code: "oc_x" });
    expect(r.ok && r.value.scopes).toEqual(["openid", "offline_access"]);
    expect(r.ok && r.value.tokenType).toBe("Bearer");
  });

  it("answers unexpected for a register or userinfo answer of a wrong shape", async () => {
    for (const body of [
      {},
      null,
      [],
      { client_id: 5, redirect_uris: [REDIRECT] },
      { client_id: "cl_a", redirect_uris: [5] },
      { client_id: "", redirect_uris: [] },
    ]) {
      const fetch = (async () => Response.json(body)) as typeof globalThis.fetch;
      expect(
        await registerOAuthClient({
          issuer: ISSUER,
          clientName: "CLI",
          redirectUris: [REDIRECT],
          fetch,
        }),
      ).toEqual({ ok: false, code: "unexpected", status: 200 });
    }
    for (const body of [null, [], "s", {}, { sub: 5 }]) {
      const { oauth } = stub(() => Response.json(body));
      expect(await oauth.userinfo("oa_x")).toEqual({ ok: false, code: "unexpected", status: 200 });
    }
  });

  it("answers unexpected for an error code outside the OAuth table, in an answer or a redirect", async () => {
    const a = stub(() => Response.json({ error: "origin_not_trusted" }, { status: 403 }));
    expect(await a.oauth.refresh("or_x")).toEqual({ ok: false, code: "unexpected", status: 403 });
    const b = stub(() => Response.json({ error: "__proto__" }, { status: 400 }));
    expect(await b.oauth.refresh("or_x")).toEqual({ ok: false, code: "unexpected", status: 400 });
    const c = stub(() => Response.json(GOOD));
    for (const error of ["toString", "nope"])
      expect(await redirectWith(c.oauth, { error })).toEqual({
        ok: false,
        code: "unexpected",
        status: 0,
      });
  });

  it("answers redirect_mismatch for a provider error with no state or an unknown state", async () => {
    const { oauth } = stub(() => Response.json(GOOD));
    await oauth.authorizeURL();
    const mismatch = { ok: false, code: "redirect_mismatch", status: 0 };
    const iss = encodeURIComponent(ISSUER);
    expect(await oauth.handleRedirect(`${REDIRECT}?error=access_denied&iss=${iss}`)).toEqual(
      mismatch,
    );
    expect(
      await oauth.handleRedirect(
        `${REDIRECT}?error=access_denied&state=${"y".repeat(43)}&iss=${iss}`,
      ),
    ).toEqual(mismatch);
  });

  it("makes a new state and a new challenge for each sign-in, from getRandomValues", async () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    const { oauth } = stub(() => Response.json(GOOD));
    const one = await oauth.authorizeURL();
    const two = await oauth.authorizeURL();
    if (!one.ok || !two.ok) throw new Error("no url");
    const [a, b] = [new URL(one.value).searchParams, new URL(two.value).searchParams];
    expect(a.get("state")).not.toBe(b.get("state"));
    expect(a.get("code_challenge")).not.toBe(b.get("code_challenge"));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    spy.mockRestore();
  });

  it("writes a space of the scope as %20 in the authorize URL", async () => {
    const { oauth } = stub(() => Response.json(GOOD));
    const u = await oauth.authorizeURL();
    expect(u.ok && u.value).toContain("scope=openid%20offline_access");
    expect(u.ok && u.value.includes("+")).toBe(false);
  });

  it("refuses the redirect of a sign-in that another client started on the same store", async () => {
    const shared = memoryPendingStore();
    const a = stub(() => Response.json(GOOD), { pending: shared });
    const b = stub(() => Response.json(GOOD), { pending: shared, clientId: "cl_b" });
    const u = await a.oauth.authorizeURL();
    if (!u.ok) throw new Error(u.code);
    const state = new URL(u.value).searchParams.get("state") ?? "";
    const back = `${REDIRECT}?code=oc_x&state=${state}&iss=${encodeURIComponent(ISSUER)}`;
    expect(await b.oauth.handleRedirect(back)).toEqual({
      ok: false,
      code: "redirect_mismatch",
      status: 0,
    });
    expect(b.sent).toHaveLength(0);
  });

  it("refuses an issuer with user info at construction", () => {
    expect(() =>
      createOAuthClient({
        issuer: "https://u:p@api.example.com/auth",
        clientId: "cl_x",
        redirectUri: REDIRECT,
        resource: RESOURCE,
        scopes: ["openid"],
      }),
    ).toThrow(/issuer/);
  });

  it("answers revoked for an empty 200, and sends no scope for a refresh with an empty list", async () => {
    const r = stub(() => new Response(null, { status: 200 }));
    expect(await r.oauth.revoke("or_x")).toEqual({ ok: true, value: { revoked: true } });
    const s = stub(() => Response.json(GOOD));
    await s.oauth.refresh("or_x", { scopes: [] });
    const body = new URLSearchParams(await (s.sent.at(-1)?.text() ?? Promise.resolve("")));
    expect(body.has("scope")).toBe(false);
  });

  it("removes a pending sign-in older than 10 minutes when a new one starts", async () => {
    const store = memoryPendingStore();
    let now = 0;
    const { oauth } = stub(() => Response.json(GOOD), {
      pending: store,
      clock: { now: () => new Date(now) },
    });
    const old = await oauth.authorizeURL();
    if (!old.ok) throw new Error(old.code);
    const state = new URL(old.value).searchParams.get("state") ?? "";
    now = PENDING_TTL_MS + 1;
    await oauth.authorizeURL();
    now = 0;
    // The clock is back, so only the sweep can explain a missing record.
    expect(await store.take(state)).toBeNull();
  });
});
