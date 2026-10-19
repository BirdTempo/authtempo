import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { markFresh } from "../src/engine/fresh.js";
import { authTimeOf } from "../src/engine/oauth-authorize.js";
import { createSession } from "../src/engine/sessions.js";
import { fromBase64Url, sha256Hex } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, get } from "./helpers.js";
import {
  type AuthorizeInput,
  authorizeParams,
  consentPost,
  exchange,
  type Handle,
  ISSUER,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  requestIdOf,
  SCOPES,
  signedIn,
} from "./oauth-helpers.js";

const dec = new TextDecoder();
const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(dec.decode(fromBase64Url(jwt.split(".")[1] ?? ""))) as Record<string, unknown>;

/** The oauth input of `oauthHandle`, with more keys. */
const oauthWith = (more: Record<string, unknown>) =>
  ({
    resources: [RESOURCE],
    scopes: SCOPES,
    registration: { cimd: false, dynamic: true },
    ...more,
  }) as NonNullable<AuthConfig["oauth"]>;

/** The authorize GET of `i` with more query pairs; a pair in `twice` goes in a second time. */
function ask(i: AuthorizeInput, more: Record<string, string>, cookie?: string, twice?: string) {
  const p = new URLSearchParams(authorizeParams(i));
  for (const [k, v] of Object.entries(more)) p.set(k, v);
  if (twice) p.append(twice, p.get(twice) ?? "x");
  return new Request(`${BASE_URL}/auth/oauth/authorize?${p}`, {
    headers: cookie ? { cookie } : {},
  });
}

const locationOf = (res: Response) => new URL(res.headers.get("location") ?? "about:blank");
const errorOf = (res: Response) => locationOf(res).searchParams.get("error");
/** The held request id of a sign-in step of core's own page. */
function signInIdOf(res: Response): string {
  const loc = locationOf(res);
  expect(`${loc.origin}${loc.pathname}`).toBe(`${BASE_URL}/auth/oauth/sign-in`);
  const next = loc.searchParams.get("next") ?? "";
  expect(next).toMatch(/^\/auth\/oauth\/authorize\?request_id=oq_[A-Za-z0-9_-]{43}$/);
  return next.slice(next.indexOf("=") + 1);
}
const back = (id: string, cookie: string) =>
  get(`/auth/oauth/authorize?request_id=${id}`, { cookie });

async function heldData(h: Handle, id: string) {
  const row = await h.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(id) },
    { field: "purpose", op: "eq", value: "oauth-request" },
  ]);
  return row?.data;
}
const heldRows = (h: Handle) =>
  h.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "oauth-request" }]);
const codeRows = (h: Handle) =>
  h.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "oauth-code" }]);

/** A new session of the same user: a new sign-in at the clock's now. */
async function signInAgain(h: Handle, userId: string) {
  const { token, session } = await createSession(h.config, { userId, ip: null, userAgent: null });
  return { session, cookie: `__Host-tempo_session=${token}` };
}

async function setup(h: Handle) {
  const s = await signedIn(h);
  const clientId = await registered(h);
  const p = await pkce();
  const input: AuthorizeInput = { clientId, challenge: p.challenge, scope: "openid mcp:read" };
  return { ...s, clientId, verifier: p.verifier, input };
}

describe("prompt=login, max_age, and auth_time (plan 12e, OIDC Core 3.1.2.1)", () => {
  it("sends prompt=login with a session to the sign-in step, and goes on only after a newer sign-in", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const at = h.clock.now().getTime();
    h.clock.advance(5_000);
    const res = await h.auth.handle(ask(s.input, { prompt: "login" }, s.cookie));
    expect(res.status).toBe(302);
    const id = signInIdOf(res);
    // The held row asks for a sign-in at or after the request; it names no user yet.
    expect(await heldData(h, id)).toMatchObject({ minAuthTime: at + 5_000, userId: null });
    // The old session on the way back gets the sign-in step again, and nothing is spent.
    h.clock.advance(1_000);
    expect(signInIdOf(await h.auth.handle(back(id, s.cookie)))).toBe(id);
    expect(await codeRows(h)).toEqual([]);
    expect((await heldRows(h))[0]?.consumedAt).toBeNull();
    // A new sign-in passes: the consent page of the same held request.
    const fresh = await signInAgain(h, s.user.id);
    const page = await h.auth.handle(back(id, fresh.cookie));
    expect(page.status).toBe(200);
    expect(requestIdOf(await page.text())).toBe(id);
    // After the bind, the old session still gets the sign-in step.
    expect(signInIdOf(await h.auth.handle(back(id, s.cookie)))).toBe(id);
    // A post from the old session decides nothing, and the new session's allow gives the code.
    const stale = await h.auth.handle(
      consentPost({ request_id: id, decision: "allow" }, { cookie: s.cookie }),
    );
    expect(locationOf(stale).searchParams.get("code")).toBeNull();
    const done = await h.auth.handle(
      consentPost({ request_id: id, decision: "allow" }, { cookie: fresh.cookie }),
    );
    expect(locationOf(done).searchParams.get("code")).toMatch(/^oc_/);
  });

  it("compares in milliseconds: a session 400 ms older than prompt=login, in the same second, gets the sign-in step", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    // The test clock starts on a whole second, so the request is in the sign-in's second.
    h.clock.advance(400);
    const id = signInIdOf(await h.auth.handle(ask(s.input, { prompt: "login" }, s.cookie)));
    expect(signInIdOf(await h.auth.handle(back(id, s.cookie)))).toBe(id);
    expect(await codeRows(h)).toEqual([]);
  });

  it("treats max_age=1 with an auth_time two seconds old as prompt=login", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    h.clock.advance(2_000);
    const id = signInIdOf(await h.auth.handle(ask(s.input, { max_age: "1" }, s.cookie)));
    expect(await heldData(h, id)).toMatchObject({ minAuthTime: h.clock.now().getTime() });
    expect(signInIdOf(await h.auth.handle(back(id, s.cookie)))).toBe(id);
    const fresh = await signInAgain(h, s.user.id);
    expect((await h.auth.handle(back(id, fresh.cookie))).status).toBe(200);
    // A max_age that the session meets shows the page at once; max_age=0 is prompt=login.
    expect((await h.auth.handle(ask(s.input, { max_age: "5" }, s.cookie))).status).toBe(200);
    expect((await h.auth.handle(ask(s.input, { max_age: "2" }, s.cookie))).status).toBe(200);
    signInIdOf(await h.auth.handle(ask(s.input, { max_age: "0" }, fresh.cookie)));
    // A value that is not a count of seconds, or a repeated one, goes back as invalid_request.
    for (const max_age of ["-1", "1.5", "1e3", " 1", "abc", "12345678901"])
      expect({
        max_age,
        error: errorOf(await h.auth.handle(ask(s.input, { max_age }, s.cookie))),
      }).toEqual({
        max_age,
        error: "invalid_request",
      });
    expect(errorOf(await h.auth.handle(ask(s.input, { max_age: "5" }, s.cookie, "max_age")))).toBe(
      "invalid_request",
    );
  });

  it("counts an empty max_age, request, request_uri, registration, or dpop_jkt as omitted (RFC 6749 3.1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    // The session is 2 s old: a max_age of 1 would send it to the sign-in step.
    h.clock.advance(2_000);
    for (const name of ["max_age", "request", "request_uri", "registration", "dpop_jkt"])
      expect({
        name,
        status: (await h.auth.handle(ask(s.input, { [name]: "" }, s.cookie))).status,
      }).toEqual({ name, status: 200 });
    // Two empty copies are omitted too; an empty copy beside a value is one value.
    expect((await h.auth.handle(ask(s.input, { max_age: "" }, s.cookie, "max_age"))).status).toBe(
      200,
    );
    const p = new URLSearchParams(authorizeParams(s.input));
    p.append("max_age", "");
    p.append("max_age", "1");
    signInIdOf(
      await h.auth.handle(
        new Request(`${BASE_URL}/auth/oauth/authorize?${p}`, { headers: { cookie: s.cookie } }),
      ),
    );
    // An empty dpop_jkt binds no key: the code exchange needs no proof.
    const page = await h.auth.handle(ask(s.input, { dpop_jkt: "" }, s.cookie));
    const done = await h.auth.handle(
      consentPost(
        { request_id: requestIdOf(await page.text()), decision: "allow" },
        {
          cookie: s.cookie,
        },
      ),
    );
    const code = locationOf(done).searchParams.get("code") ?? "";
    expect((await h.auth.handle(exchange(code, s.clientId, s.verifier))).status).toBe(200);
  });

  it("refuses request, request_uri, and registration with an empty copy beside a value, or two copies of a value", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const withPairs = (pairs: [string, string][]) => {
      const p = new URLSearchParams(authorizeParams(s.input));
      for (const [k, v] of pairs) p.append(k, v);
      return new Request(`${BASE_URL}/auth/oauth/authorize?${p}`, {
        headers: { cookie: s.cookie },
      });
    };
    const cases: [string, string][] = [
      ["request", "request_not_supported"],
      ["request_uri", "request_uri_not_supported"],
      ["registration", "registration_not_supported"],
    ];
    for (const [name, error] of cases)
      for (const values of [
        ["", "x"],
        ["x", ""],
        ["x", "x"],
      ]) {
        const pairs = values.map((v): [string, string] => [name, v]);
        expect({ name, values, error: errorOf(await h.auth.handle(withPairs(pairs))) }).toEqual({
          name,
          values,
          error,
        });
      }
    // An empty max_age beside max_age=0 is one value: the sign-in step.
    for (const values of [
      ["", "0"],
      ["0", ""],
    ])
      signInIdOf(
        await h.auth.handle(withPairs(values.map((v): [string, string] => ["max_age", v]))),
      );
    expect(await codeRows(h)).toEqual([]);
  });

  it("answers login_required to prompt=none with either case", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    h.clock.advance(2_000);
    const before = (await heldRows(h)).length;
    for (const more of [
      { prompt: "none", max_age: "1" },
      { prompt: "none", max_age: "0" },
    ]) {
      const res = await h.auth.handle(ask(s.input, more, s.cookie));
      // No page: a redirect to the client with the state and iss.
      expect(res.status).toBe(302);
      const loc = locationOf(res);
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(Object.fromEntries(loc.searchParams)).toEqual({
        error: "login_required",
        state: "st-1",
        iss: ISSUER,
      });
    }
    // No session at all: login_required too.
    expect(errorOf(await h.auth.handle(ask(s.input, { prompt: "none", max_age: "1" })))).toBe(
      "login_required",
    );
    // OIDC Core 3.1.2.1: none with another value is an error, so none with login is invalid_request.
    expect(errorOf(await h.auth.handle(ask(s.input, { prompt: "none login" }, s.cookie)))).toBe(
      "invalid_request",
    );
    expect((await heldRows(h)).length).toBe(before);
    expect(await codeRows(h)).toEqual([]);
  });

  it("writes auth_time as the later of createdAt and freshAt", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const signIn = Math.floor(h.clock.now().getTime() / 1000);
    expect(authTimeOf(s.session)).toBe(signIn);
    const idToken = async (cookie: string) => {
      const page = await h.auth.handle(ask(s.input, {}, cookie));
      let location = page.headers.get("location") ?? "";
      if (page.status === 200) {
        const done = await h.auth.handle(
          consentPost(
            { request_id: requestIdOf(await page.text()), decision: "allow" },
            { cookie },
          ),
        );
        location = done.headers.get("location") ?? "";
      }
      const code = new URL(location).searchParams.get("code") ?? "";
      const t = await h.auth.handle(exchange(code, s.clientId, s.verifier));
      expect(t.status).toBe(200);
      return claimsOf(((await t.json()) as { id_token: string }).id_token);
    };
    // The request comes 90 s after the sign-in: auth_time is the sign-in, not the request.
    h.clock.advance(90_000);
    const first = await idToken(s.cookie);
    expect(first.auth_time).toBe(signIn);
    expect(first.iat).toBe(signIn + 90);
    // A re-authentication of plan 12a counts as a sign-in.
    h.clock.advance(30_000);
    expect((await markFresh(h.config, s.session.id)).ok).toBe(true);
    const row = await h.storage.findOne("session", [
      { field: "id", op: "eq", value: s.session.id },
    ]);
    if (!row) throw new Error("no session");
    expect(authTimeOf(row)).toBe(signIn + 120);
    h.clock.advance(10_000);
    const second = await idToken(s.cookie);
    expect(second.auth_time).toBe(signIn + 120);
    expect(second.iat).toBe(signIn + 130);
  });

  it("redirects request, request_uri, and registration to the client with their errors (OIDC Core 3.1.2.6)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const cases: [string, string][] = [
      ["request", "request_not_supported"],
      ["request_uri", "request_uri_not_supported"],
      ["registration", "registration_not_supported"],
    ];
    for (const [name, error] of cases) {
      const res = await h.auth.handle(ask(s.input, { [name]: "x" }, s.cookie));
      const loc = locationOf(res);
      expect({
        name,
        at: `${loc.origin}${loc.pathname}`,
        q: Object.fromEntries(loc.searchParams),
      }).toEqual({
        name,
        at: REDIRECT,
        q: { error, state: "st-1", iss: ISSUER },
      });
      // With no session the same answer, and nothing is held.
      expect(errorOf(await h.auth.handle(ask(s.input, { [name]: "x" })))).toBe(error);
      // A redirect URI that is not registered never redirects: the error page of core.
      const bad = await h.auth.handle(
        ask({ ...s.input, redirectUri: "https://evil.example/cb" }, { [name]: "x" }, s.cookie),
      );
      expect({ name, status: bad.status, location: bad.headers.get("location") }).toEqual({
        name,
        status: 400,
        location: null,
      });
      expect(await bad.json()).toEqual({ error: "invalid_request" });
    }
    expect(await heldRows(h)).toEqual([]);
    expect(await codeRows(h)).toEqual([]);
  });

  it("reads display, ui_locales, claims_locales, login_hint, acr_values, id_token_hint, and claims once and ignores them", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const names = [
      "display",
      "ui_locales",
      "claims_locales",
      "login_hint",
      "acr_values",
      "id_token_hint",
      "claims",
    ];
    const all = Object.fromEntries(names.map((n) => [n, "x"]));
    expect((await h.auth.handle(ask(s.input, all, s.cookie))).status).toBe(200);
    for (const name of names)
      expect({
        name,
        error: errorOf(await h.auth.handle(ask(s.input, { [name]: "x" }, s.cookie, name))),
      }).toEqual({ name, error: "invalid_request" });
  });

  it("sends the browser to signInURL with request_id and nothing else", async () => {
    for (const [signInURL, at] of [
      [`${APP_ORIGIN}/login`, `${APP_ORIGIN}/login`],
      ["/account/sign-in", `${APP_ORIGIN}/account/sign-in`],
      [`${BASE_URL}/sign-in`, `${BASE_URL}/sign-in`],
    ]) {
      const h = oauthHandle({ appURL: APP_ORIGIN, oauth: oauthWith({ signInURL }) });
      const s = await setup(h);
      for (const [more, cookie] of [
        [{}, undefined],
        [{ prompt: "login" }, s.cookie],
        [{ max_age: "0" }, s.cookie],
      ] as const) {
        const res = await h.auth.handle(ask(s.input, more, cookie));
        expect(res.status).toBe(302);
        const loc = locationOf(res);
        expect(`${loc.origin}${loc.pathname}`).toBe(at);
        expect([...loc.searchParams.keys()]).toEqual(["request_id"]);
        expect(loc.searchParams.get("request_id")).toMatch(/^oq_[A-Za-z0-9_-]{43}$/);
        expect(loc.hash).toBe("");
      }
      // The app sends the browser back with the id alone, after a new sign-in.
      const res = await h.auth.handle(ask(s.input, {}));
      const id = locationOf(res).searchParams.get("request_id") ?? "";
      h.clock.advance(1_000);
      const fresh = await signInAgain(h, s.user.id);
      expect((await h.auth.handle(back(id, fresh.cookie))).status).toBe(200);
    }
  });

  it("refuses a signInURL on a foreign origin or with http", () => {
    const make = (signInURL: string) => () =>
      oauthHandle({ appURL: APP_ORIGIN, oauth: oauthWith({ signInURL }) });
    for (const bad of [
      "https://evil.example/login",
      "http://app.example.com/login",
      "https://app.example.com.evil.example/login",
      "https://user@app.example.com/login",
      "https://app.example.com/login?next=x",
      "https://app.example.com/login#x",
      "//evil.example/login",
      "/\\evil.example/login",
      "/login?next=x",
      "/login#x",
      "login",
      "",
      "javascript:alert(1)",
    ])
      expect(make(bad), bad).toThrow(ConfigError);
    expect(() => oauthHandle({ oauth: oauthWith({ signInURL: 42 }) })).toThrow(ConfigError);
    // An http origin that the app trusts is still not https.
    const dev = "http://dev.example.com";
    expect(() =>
      oauthHandle({
        trustedOrigins: [APP_ORIGIN, dev],
        oauth: oauthWith({ signInURL: `${dev}/login` }),
      }),
    ).toThrow(ConfigError);
    for (const good of ["https://app.example.com/login", `${BASE_URL}/x`, "/login"])
      expect(make(good), good).not.toThrow();
  });
});
