import { describe, expect, it } from "vitest";
import { type AuthConfig, type MailMessage, resolveConfig } from "../src/config.js";
import { createAuth, crossSiteRefusal } from "../src/create-auth.js";
import { validCimdUrl } from "../src/engine/oauth-clients.js";
import { createSession } from "../src/engine/sessions.js";
import { json } from "../src/http/json.js";
import { createRouter, type Route } from "../src/http/router.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { newId } from "../src/primitives/ids.js";
import { tiktokEntry } from "../src/social/entries/index.js";
import tiktokTokenText from "./fixtures/providers/tiktok/token.json?raw";
import tiktokUserText from "./fixtures/providers/tiktok/user.json?raw";
import { makeAuth, recordAddress, recordCredential, tokenFromMail } from "./helpers.js";
import { pkce, requestIdOf } from "./oauth-helpers.js";
import { fakeFetch, GOOGLE } from "./social-helpers.js";

// The base URL list (plan 12i Task 18, spec 32 item 18). The router picks
// the entry equal to the origin of `request.url`, and every value that core
// builds from `baseURL` follows that entry. No header picks a host.

const A = "https://a.example";
const B = "https://b.example";
const SECRET = "0123456789abcdef0123456789abcdef";
const REDIRECT = "https://client.example.com/callback";
const RESOURCE = "https://api.example.org/mcp";

/** One auth over the list [A, B] by default, with its mail, storage, and clock. */
function world(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const mail: MailMessage[] = [];
  const input: AuthConfig = {
    baseURL: [A, B],
    secret: SECRET,
    trustedOrigins: [],
    storage: base.storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    ...extra,
  };
  return { ...base, input, auth: createAuth(input), config: resolveConfig(input), mail };
}

/** A JSON POST to `host`, as a page on `origin` sends it. */
function postOn(host: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: host, ...headers },
    body: JSON.stringify(body),
  });
}

/** A form POST to `host` from its own page, or with no Origin (a native client). */
function formOn(host: string, path: string, body: Record<string, string>, origin = true) {
  return new Request(`${host}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin ? { origin: host } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** A router with one probe route that answers the config the request ran with. */
function probe(input: Partial<AuthConfig> = {}) {
  let runs = 0;
  const config = resolveConfig({ ...world().input, ...input });
  const route: Route = {
    method: "GET",
    path: "/probe",
    async handler(ctx) {
      runs++;
      return json({ baseURL: ctx.config.baseURL, appURL: ctx.config.appURL });
    },
  };
  const handle = createRouter(config, [route]);
  return { handle, runs: () => runs };
}

/** A user row and the cookie of a session of it. */
async function signedIn(w: ReturnType<typeof world>, email = "ada@example.com") {
  recordAddress(email);
  const now = w.clock.now();
  const user = await w.storage.create("user", {
    id: newId(now),
    email,
    emailVerified: true,
    name: "Ada",
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: now,
    updatedAt: now,
  });
  const { token } = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
  recordCredential(token);
  return { user, cookie: `__Host-tempo_session=${token}` };
}

/** The claims of a JWT, unchecked. */
function claimsOf(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

describe("the base URL list (plan 12i Task 18)", () => {
  it("picks the entry of the request's host", async () => {
    const p = probe();
    const onB = await p.handle(new Request(`${B}/auth/probe`));
    expect(await onB.json()).toEqual({ baseURL: B, appURL: B });
    const onA = await p.handle(new Request(`${A}/auth/probe`));
    expect(await onA.json()).toEqual({ baseURL: A, appURL: A });
    // The URL parser lowers the case of a host, so the entry is the same.
    const upper = await p.handle(new Request("https://B.EXAMPLE/auth/probe"));
    expect(await upper.json()).toEqual({ baseURL: B, appURL: B });
    // An IDN host: the entry is in punycode, and the parser writes the request's host so.
    const idn = probe({ baseURL: [A, "https://xn--bcher-kva.example"] });
    const res = await idn.handle(new Request("https://bücher.example/auth/probe"));
    expect(await res.json()).toEqual({
      baseURL: "https://xn--bcher-kva.example",
      appURL: "https://xn--bcher-kva.example",
    });
    // An appURL of the app's own stays on every entry.
    const app = probe({ appURL: "https://app.example", trustedOrigins: ["https://app.example"] });
    const own = await app.handle(new Request(`${B}/auth/probe`));
    expect(await own.json()).toEqual({ baseURL: B, appURL: "https://app.example" });
  });

  it("answers 421 host_not_allowed for another host or scheme, and reads no forwarded header", async () => {
    const p = probe();
    const spoofed = new Request("https://c.example/auth/probe", {
      headers: {
        "x-forwarded-host": "a.example",
        "x-forwarded-proto": "https",
        forwarded: "host=a.example;proto=https",
      },
    });
    const refusals = [
      spoofed,
      new Request("http://b.example/auth/probe"),
      new Request("https://b.example:8443/auth/probe"),
      new Request("https://b.example./auth/probe"),
      new Request("https://b.example.evil.example/auth/probe"),
      // Before the route match and before the preflight answer, too.
      new Request("https://c.example/auth/no-such-route"),
      new Request("https://c.example/auth/probe", {
        method: "OPTIONS",
        headers: { origin: A, "access-control-request-method": "POST" },
      }),
    ];
    for (const request of refusals) {
      const res = await p.handle(request);
      expect(res.status).toBe(421);
      expect(await res.text()).toBe('{"error":"host_not_allowed"}');
    }
    expect(p.runs()).toBe(0);
    // A header that names another entry picks nothing on an entry either.
    const onA = await p.handle(
      new Request(`${A}/auth/probe`, { headers: { "x-forwarded-host": "b.example" } }),
    );
    expect(await onA.json()).toEqual({ baseURL: A, appURL: A });
    // The whole auth: the router, the well-known handler, and the gate of the shim paths.
    const w = world({ oauth: { resources: [RESOURCE], registration: { cimd: false } } });
    const routed = await w.auth.handle(postOn("https://c.example", "/auth/magic-link/request", {}));
    expect(routed.status).toBe(421);
    const known = await w.auth.wellKnown(
      new Request("https://c.example/.well-known/oauth-authorization-server/auth"),
    );
    expect(known.status).toBe(421);
    expect(crossSiteRefusal(w.auth, new Request("https://c.example/auth/x"))?.status).toBe(421);
    expect(crossSiteRefusal(w.auth, new Request(`${B}/auth/x`))).toBeNull();
    // A baseURL string answers every host, as before plan 12i.
    const one = probe({ baseURL: A });
    const any = await one.handle(new Request("https://c.example/auth/probe"));
    expect(await any.json()).toEqual({ baseURL: A, appURL: A });
  });

  it("follows the host in the issuer, the mail link, the callback, and the Origin check", async () => {
    const f = fakeFetch(() => new Response("not found", { status: 404 }));
    const w = world({
      oauth: { resources: [RESOURCE], registration: { cimd: false } },
      social: { google: GOOGLE, fetch: f.fetchFn },
    });
    for (const host of [A, B]) {
      const doc = await w.auth.handle(new Request(`${host}/auth/.well-known/openid-configuration`));
      expect(((await doc.json()) as { issuer: string }).issuer).toBe(`${host}/auth`);
      const root = await w.auth.wellKnown(
        new Request(`${host}/.well-known/oauth-authorization-server/auth`),
      );
      const body = (await root.json()) as { issuer: string; token_endpoint: string };
      expect(body.issuer).toBe(`${host}/auth`);
      expect(body.token_endpoint).toBe(`${host}/auth/oauth/token`);
    }
    const sent = await w.auth.handle(
      postOn(B, "/auth/magic-link/request", { email: recordAddress("ada@example.com") }),
    );
    expect(sent.status).toBe(200);
    expect(w.mail[0]?.text).toContain(`${B}/auth/magic-link/verify?token=`);
    expect(w.mail[0]?.text).not.toContain(A);
    const start = await w.auth.handle(new Request(`${B}/auth/social/google/start`));
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe(`${B}/auth/social/google/callback`);
    // A failure lands on the default appURL of the entry.
    const bad = await w.auth.handle(new Request(`${B}/auth/magic-link/verify?token=x`));
    expect(bad.headers.get("location")).toBe(`${B}/?auth_error=invalid_token`);
    // The Origin rule names the request's entry: another entry is no trusted origin.
    const cross = await w.auth.handle(
      postOn(B, "/auth/magic-link/request", { email: "ada@example.com" }, { origin: A }),
    );
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: "origin_not_trusted" });
    const trusted = world({ trustedOrigins: [A] });
    const passed = await trusted.auth.handle(
      postOn(B, "/auth/magic-link/request", { email: "ada@example.com" }, { origin: A }),
    );
    expect(passed.status).toBe(200);
  });

  it("keeps a session per host", async () => {
    const w = world();
    await w.auth.handle(
      postOn(A, "/auth/magic-link/request", { email: recordAddress("ada@example.com") }),
    );
    const token = tokenFromMail(w.mail[0]?.text ?? "");
    const res = await w.auth.handle(postOn(A, "/auth/magic-link/verify", { token }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-tempo_session="))).toBe(true);
    // `__Host-` with no Domain: a browser sends the cookie to the host that set it only.
    for (const c of cookies) expect(c.toLowerCase()).not.toContain("domain=");
  });

  it("verifies a JWT of any entry's issuer and refuses an OAuth code on another entry", async () => {
    const w = world({
      oauth: { resources: [RESOURCE], registration: { cimd: false, dynamic: true } },
    });
    const s = await signedIn(w);
    const minted = await w.auth.handle(
      new Request(`${A}/auth/token`, { headers: { cookie: s.cookie } }),
    );
    const { token } = (await minted.json()) as { token: string };
    recordCredential(token);
    expect(claimsOf(token)).toMatchObject({ iss: `${A}/auth`, aud: A });
    const live = await w.auth.handle(
      new Request(`${B}/auth/token/live`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ live: true });
    // A code minted on A.
    const reg = await w.auth.handle(
      postOn(A, "/auth/oauth/register", { redirect_uris: [REDIRECT], client_name: "Client" }),
    );
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    /** The authorize step on `host`: the consent page, or the redirect of a covered consent. */
    const authorize = async (host: string, scope: string) => {
      const p = await pkce();
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: p.challenge,
        code_challenge_method: "S256",
        scope,
        resource: RESOURCE,
        state: "st",
      });
      const page = await w.auth.handle(
        new Request(`${host}/auth/oauth/authorize?${query}`, { headers: { cookie: s.cookie } }),
      );
      return { page, verifier: p.verifier };
    };
    /** The allow of the consent form, posted from `host` to `host`. */
    const allow = (host: string, requestId: string) =>
      w.auth.handle(
        new Request(`${host}/auth/oauth/authorize`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: host,
            cookie: s.cookie,
          },
          body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
        }),
      );
    const code = async (host: string) => {
      const { page, verifier } = await authorize(host, "openid");
      // The first request shows the consent page; the consent then covers the next.
      const done = page.status !== 200 ? page : await allow(host, requestIdOf(await page.text()));
      const back = new URL(done.headers.get("location") ?? "");
      expect(back.searchParams.get("iss")).toBe(`${host}/auth`);
      return { code: recordCredential(back.searchParams.get("code") ?? ""), verifier };
    };
    const exchange = (host: string, c: { code: string; verifier: string }) =>
      w.auth.handle(
        formOn(
          host,
          "/auth/oauth/token",
          {
            grant_type: "authorization_code",
            code: c.code,
            code_verifier: c.verifier,
            client_id: clientId,
            redirect_uri: REDIRECT,
            resource: RESOURCE,
          },
          false,
        ),
      );
    const other = await exchange(B, await code(A));
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: "invalid_grant" });
    const own = await exchange(A, await code(A));
    expect(own.status).toBe(200);
    const answer = (await own.json()) as { id_token: string; access_token: string };
    expect(claimsOf(recordCredential(answer.id_token)).iss).toBe(`${A}/auth`);
    // An access token of A's issuer passes at B's userinfo: a JWT of any entry verifies.
    const info = await w.auth.handle(
      new Request(`${B}/auth/oauth/userinfo`, {
        headers: { authorization: `Bearer ${recordCredential(answer.access_token)}` },
      }),
    );
    expect(info.status).toBe(200);
    // A request that A holds is not found on B: B's consent gives no code.
    const held = await authorize(A, "openid profile");
    expect(held.page.status).toBe(200);
    const onB = await allow(B, requestIdOf(await held.page.text()));
    expect(onB.status).toBe(400);
    expect(onB.headers.get("location")).toBeNull();
  });

  it("uses the primary outside a request", async () => {
    const w = world();
    expect(w.auth.baseURL).toBe(A);
    const r = await w.auth.api.requestMagicLink({
      email: recordAddress("ada@example.com"),
      ip: null,
    });
    expect(r.ok).toBe(true);
    expect(w.mail[0]?.text).toContain(`${A}/auth/magic-link/verify?token=`);
    const s = await signedIn(w);
    const jwt = await w.auth.handle(
      new Request(`${B}/auth/token`, { headers: { cookie: s.cookie } }),
    );
    expect(jwt.status).toBe(200);
    const swept = await w.auth.api.sweepExpired();
    expect(swept).toMatchObject({ sessions: 0 });
    const api = w.auth.api.jwt;
    if (!api) throw new Error("jwtMint is on by default");
    const session = await w.storage.findOne("session", [
      { field: "userId", op: "eq", value: s.user.id },
    ]);
    if (!session) throw new Error("the session row is gone");
    const minted = await api.mint({ userId: s.user.id, sessionId: session.id });
    if (!minted.ok) throw new Error(minted.code);
    expect(claimsOf(recordCredential(minted.value.token))).toMatchObject({
      iss: `${A}/auth`,
      aud: A,
    });
  });

  it("refuses a wildcard, a path, http on a public host, a duplicate, and 21 entries", () => {
    const refused = (baseURL: unknown, message: RegExp) =>
      expect(() => world({ baseURL: baseURL as string[] })).toThrow(message);
    refused([A, "https://*.vercel.app"], /baseURL\[1\] has a wildcard/);
    refused([A, `${B}/auth`], /baseURL\[1\] must be an origin with no path/);
    refused([A, `${B}/`], /baseURL\[1\] must be an origin with no path/);
    refused([A, "http://b.example"], /baseURL\[1\] must be https, or http on localhost/);
    refused([A, "http://[::1]:8787"], /baseURL\[1\] must be https, or http on localhost/);
    refused([A, B, A], /baseURL\[2\] repeats https:\/\/a.example/);
    const many = Array.from({ length: 21 }, (_, i) => `https://h${i}.example`);
    refused(many, /a list of 1 to 20 origins/);
    refused([], /a list of 1 to 20 origins/);
    refused([A, "https://B.example"], /normal form: https:\/\/b.example/);
    refused([A, "https://b.example:443"], /normal form: https:\/\/b.example/);
    refused([A, "https://bücher.example"], /normal form: https:\/\/xn--bcher-kva.example/);
    refused([A, "https://u:p@b.example"], /baseURL\[1\] must have no user name/);
    // An entry is this instance's own host: no outbound URL may name it.
    expect(() =>
      world({ social: { gitlab: { clientId: "g", clientSecret: "g", issuer: B } } }),
    ).toThrow(/social.gitlab.issuer/);
    expect(validCimdUrl(`${B}/client.json`, [A, B])).toBe(false);
    expect(validCimdUrl("https://client.example/client.json", [A, B])).toBe(true);
    expect(
      world({ baseURL: Array.from({ length: 20 }, (_, i) => `https://h${i}.example`) }).config
        .baseURLs,
    ).toHaveLength(20);
    expect(
      world({ baseURL: ["http://localhost:8787", "http://127.0.0.1:8787"] }).config.baseURL,
    ).toBe("http://localhost:8787");
    // A redirectURI override is on an entry of the list (ruling 21 of plan 12i).
    const github = { clientId: "gh", clientSecret: "gh" };
    expect(() =>
      world({ social: { github: { ...github, redirectURI: `${B}/auth/oauth/github` } } }),
    ).not.toThrow();
    expect(() =>
      world({
        social: { github: { ...github, redirectURI: "https://c.example/auth/oauth/github" } },
      }),
    ).toThrow(/redirectURI must have the origin of baseURL/);
  });

  it("finishes a sign-in with a redirectURI override on the host where it started", async () => {
    const tokenUrl = "https://github.com/login/oauth/access_token";
    const f = fakeFetch((call) => {
      if (call.url === tokenUrl)
        return Response.json({ access_token: "gho_x", scope: "read:user", token_type: "bearer" });
      if (call.url === "https://api.github.com/user")
        return Response.json({ login: "ada", id: 7, name: "Ada", email: null, avatar_url: null });
      if (call.url === "https://api.github.com/user/emails")
        return Response.json([
          { email: "ada@example.com", primary: true, verified: true, visibility: null },
        ]);
      return new Response("not found", { status: 404 });
    });
    const w = world({
      social: {
        github: { clientId: "gh", clientSecret: "gh", redirectURI: `${A}/auth/oauth/github` },
        fetch: f.fetchFn,
      },
    });
    const start = await w.auth.handle(new Request(`${B}/auth/social/github/start?next=/home`));
    const url = new URL(start.headers.get("location") ?? "");
    expect(url.searchParams.get("redirect_uri")).toBe(`${B}/auth/oauth/github`);
    const set = start.headers.getSetCookie().find((c) => c.startsWith("__Secure-")) ?? "";
    expect(set).toContain("; Path=/auth/oauth/github;");
    expect(set.toLowerCase()).not.toContain("domain=");
    const pair = set.split(";")[0] ?? "";
    const state = encodeURIComponent(url.searchParams.get("state") ?? "");
    const done = await w.auth.handle(
      new Request(`${B}/auth/oauth/github?code=c&state=${state}`, { headers: { cookie: pair } }),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${B}/home`);
    expect(done.headers.getSetCookie().some((c) => c.startsWith("__Host-tempo_session="))).toBe(
      true,
    );
    expect(f.calls.find((c) => c.url === tokenUrl)?.form.redirect_uri).toBe(
      `${B}/auth/oauth/github`,
    );
  });

  it("gives the tokenRequest hook the callback of the entry where the sign-in started", async () => {
    // The TikTok entry exchanges its code through the Task 22 hook, not the standard exchange.
    const sent: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const real = new Request(input, init);
      sent.push(`${real.method} ${real.url} ${await real.text()}`);
      if (real.url.startsWith("https://open.tiktokapis.com/v2/oauth/token/"))
        return new Response(tiktokTokenText);
      if (real.url.startsWith("https://open.tiktokapis.com/v2/user/info/"))
        return new Response(tiktokUserText);
      return new Response("not found", { status: 404 });
    };
    const w = world({
      social: {
        oauth2: [tiktokEntry({ clientKey: "tiktok-client-key", clientSecret: "tt-secret" })],
        fetch: fetchFn,
      },
    });
    const start = await w.auth.handle(new Request(`${B}/auth/social/tiktok/start?next=/home`));
    const url = new URL(start.headers.get("location") ?? "");
    expect(url.searchParams.get("redirect_uri")).toBe(`${B}/auth/social/tiktok/callback`);
    const set = start.headers.getSetCookie().find((c) => c.startsWith("__Secure-")) ?? "";
    const state = encodeURIComponent(url.searchParams.get("state") ?? "");
    const done = await w.auth.handle(
      new Request(`${B}/auth/social/tiktok/callback?code=c&state=${state}`, {
        headers: { cookie: set.split(";")[0] ?? "" },
      }),
    );
    const token = sent.find((s) => s.includes("/v2/oauth/token/")) ?? "";
    expect(new URLSearchParams(token.split(" ")[2]).get("redirect_uri")).toBe(
      `${B}/auth/social/tiktok/callback`,
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${B}/home`);
  });

  it("mints a session JWT on B for B's audience, and B verifies it", async () => {
    const w = world();
    const s = await signedIn(w);
    const minted = await w.auth.handle(
      new Request(`${B}/auth/token`, { headers: { cookie: s.cookie } }),
    );
    const { token } = (await minted.json()) as { token: string };
    expect(claimsOf(recordCredential(token))).toMatchObject({ iss: `${B}/auth`, aud: B });
    const live = await w.auth.handle(
      new Request(`${B}/auth/token/live`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(await live.json()).toEqual({ live: true });
  });

  it("mails the invitation link and the reset link of B for a request on B", async () => {
    const w = world({ organizations: {}, password: {} });
    const s = await signedIn(w);
    const created = await w.auth.handle(
      postOn(B, "/auth/organizations/create", { slug: "acme", name: "Acme" }, { cookie: s.cookie }),
    );
    const { organization } = (await created.json()) as { organization: { id: string } };
    const invited = await w.auth.handle(
      postOn(
        B,
        "/auth/organizations/invite",
        { organizationId: organization.id, email: recordAddress("bo@example.com"), role: "member" },
        { cookie: s.cookie },
      ),
    );
    expect(invited.status).toBe(200);
    expect(w.mail.at(-1)?.text).toContain(`${B}/?invitation=inv_`);
    const reset = await w.auth.handle(
      postOn(B, "/auth/password/reset/request", { email: "ada@example.com" }),
    );
    expect(reset.status).toBe(200);
    expect(w.mail.at(-1)?.text).toContain(`${B}/auth/password/reset?token=`);
    for (const m of w.mail) expect(m.text).not.toContain(A);
  });

  it("names B's issuer as the Basic realm of a client refused on B", async () => {
    const w = world({ oauth: { resources: [RESOURCE], registration: { cimd: false } } });
    // A client id that no client holds, in a Basic header: invalid_client with the challenge.
    const res = await w.auth.handle(
      new Request(`${B}/auth/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa("cl_none:wrong")}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Basic realm="${B}/auth"`);
  });
});

describe("the back-channel logout on a base URL list (plan 12i Task 18)", () => {
  const BC = "https://client.example.com/backchannel";
  const AFTER = "https://client.example.com/signed-out";

  /** A world whose fetch keeps each back-channel post. */
  function logoutWorld(extra: Partial<AuthConfig> = {}) {
    const posts: { url: string; body: string }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const w = world({
      oauth: {
        resources: [RESOURCE],
        registration: { cimd: false, dynamic: true },
        fetch: fetchFn,
      },
      ...extra,
    });
    /** The `iss` of each logout token that reached the client. */
    const logoutIssuers = () =>
      posts
        .filter((p) => p.url === BC)
        .map((p) => claimsOf(new URLSearchParams(p.body).get("logout_token") ?? "").iss);
    return { ...w, posts, logoutIssuers };
  }

  /** A client with a back-channel URI gets an ID token on `host`; answers the token. */
  async function idTokenOn(w: ReturnType<typeof logoutWorld>, host: string, cookie: string) {
    const reg = await w.auth.handle(
      postOn(host, "/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        backchannel_logout_uri: BC,
        post_logout_redirect_uris: [AFTER],
      }),
    );
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const p = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: p.challenge,
      code_challenge_method: "S256",
      scope: "openid",
      resource: RESOURCE,
      state: "st",
      nonce: "n",
    });
    const page = await w.auth.handle(
      new Request(`${host}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
    );
    const done =
      page.status !== 200
        ? page
        : await w.auth.handle(
            new Request(`${host}/auth/oauth/authorize`, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: host,
                cookie,
              },
              body: new URLSearchParams({
                request_id: requestIdOf(await page.text()),
                decision: "allow",
              }).toString(),
            }),
          );
    const code = recordCredential(
      new URL(done.headers.get("location") ?? "").searchParams.get("code") ?? "",
    );
    const tok = await w.auth.handle(
      formOn(
        host,
        "/auth/oauth/token",
        {
          grant_type: "authorization_code",
          code,
          code_verifier: p.verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        },
        false,
      ),
    );
    expect(tok.status).toBe(200);
    const { id_token: idToken } = (await tok.json()) as { id_token: string };
    return recordCredential(idToken);
  }

  const signOutOn = (w: ReturnType<typeof logoutWorld>, host: string, cookie: string) =>
    w.auth.handle(postOn(host, "/auth/sign-out", {}, { cookie }));

  it("names the issuer of the client's ID token when the sweep ends the session", async () => {
    const w = logoutWorld();
    const s = await signedIn(w);
    expect(claimsOf(await idTokenOn(w, B, s.cookie)).iss).toBe(`${B}/auth`);
    // OIDC Back-Channel Logout 1.0 section 2.6: the client checks iss as for its ID token.
    w.clock.advance(400 * 24 * 60 * 60_000);
    await w.auth.api.sweepExpired();
    expect(w.logoutIssuers()).toEqual([`${B}/auth`]);
  });

  it("names the issuer of the link on B when the sign-out is on A", async () => {
    const w = logoutWorld();
    const s = await signedIn(w);
    await idTokenOn(w, B, s.cookie);
    expect((await signOutOn(w, A, s.cookie)).status).toBe(200);
    expect(w.logoutIssuers()).toEqual([`${B}/auth`]);
  });

  it("names the stored issuer of an entry that left the list", async () => {
    const w = logoutWorld();
    const s = await signedIn(w);
    await idTokenOn(w, B, s.cookie);
    // The deployment drops B. The client checks iss as for its ID token (section 2.6),
    // so a token that names A leaves its session live.
    const later = createAuth({ ...w.input, baseURL: [A] });
    const out = await later.handle(postOn(A, "/auth/sign-out", {}, { cookie: s.cookie }));
    expect(out.status).toBe(200);
    expect(w.logoutIssuers()).toEqual([`${B}/auth`]);
  });

  it("takes an ID token hint of B at the end-session route on A", async () => {
    const w = logoutWorld();
    const s = await signedIn(w);
    const hint = await idTokenOn(w, B, s.cookie);
    const query = new URLSearchParams({
      id_token_hint: hint,
      post_logout_redirect_uri: AFTER,
      state: "st",
    });
    // A valid hint names the session: no confirm page, and the redirect goes to the client.
    const res = await w.auth.handle(
      new Request(`${A}/auth/oauth/end-session?${query}`, { headers: { cookie: s.cookie } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${AFTER}?state=st`);
    expect(w.logoutIssuers()).toEqual([`${B}/auth`]);
  });
});
