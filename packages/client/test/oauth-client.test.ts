import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { createOAuthClient, OAUTH_CALLS, registerOAuthClient } from "../src/oauth/index.js";
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
