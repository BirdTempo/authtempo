import { describe, expect, it, vi } from "vitest";
import { CAPTCHA_FLOWS, CAPTCHA_HEADER } from "../src/captcha.js";
import type { AuthConfig } from "../src/config.js";
import { requestAccountDelete } from "../src/engine/account-delete.js";
import { signInAnonymous } from "../src/engine/anonymous.js";
import { requestEmailChange } from "../src/engine/email-change.js";
import { requestEmailOtp, requestResetOtp } from "../src/engine/email-otp.js";
import { continueHandoff, startHandoff } from "../src/engine/handoff.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { inviteMember } from "../src/engine/invitations.js";
import { mintSessionJwt } from "../src/engine/jwt.js";
import { requestMagicLink } from "../src/engine/magic-link.js";
import {
  createOrganizationToken,
  ORGANIZATION_TOKEN_CAP,
} from "../src/engine/organization-tokens.js";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  passkeySignUpOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { passwordSignIn, passwordSignUp, requestPasswordReset } from "../src/engine/password.js";
import { addPhone, requestPhone, verifyAddPhone } from "../src/engine/phone.js";
import { requestReauthCode } from "../src/engine/reauth.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { enableEmailMethod } from "../src/engine/second-factor-methods.js";
import { createSession } from "../src/engine/sessions.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { addDomain } from "../src/engine/sso/domains.js";
import { addTeamMember, createTeam } from "../src/engine/teams.js";
import { API_TOKEN_CAP, createApiToken } from "../src/engine/tokens.js";
import { CHALLENGE_MAX_ATTEMPTS } from "../src/engine/totp.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { AUTH_ERROR_PARAM } from "../src/http/redirect.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { fromBase64Url } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { SOCIAL } from "./every-feature.js";
import { BASE_URL, emailOf, makeAuth, seedPlatform, tokenFromMail } from "./helpers.js";
import {
  authorized,
  codeFor,
  exchange,
  oauthHandle,
  pkce,
  registered,
  signedIn,
} from "./oauth-helpers.js";
import { FAST, upSession } from "./password-helpers.js";
import {
  APPLE,
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleClaims,
  googleSignIn,
  tokenEndpoint,
} from "./social-helpers.js";
import { codeNow, enrolled, PASSWORD, verifiedSession, wrongFor } from "./totp-helpers.js";

/**
 * The codes that one world answers on every route that declares them (plan
 * 11g Task 5). Each family reads its routes from `ROUTES`, so a route that
 * gains the code joins the family. The answer recorder then sees the code
 * on each route. A route whose check comes after another refusal needs a
 * body that passes the earlier checks. `BODIES` holds one valid body per
 * POST, and the first test holds each one to the contract's schema.
 */

const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;
/** 43 characters of a token body, as every `xx_` token of core has. */
const BODY43 = "A".repeat(43);
/** A ceremony answer whose client data decodes to nothing: the passkey check refuses it. */
const CEREMONY = { id: "cred-1", response: { clientDataJSON: "e30" } };
/** A ceremony answer whose client data names `challenge` and that no authenticator signed. */
function ceremonyOf(challenge: string) {
  const clientDataJSON = btoa(JSON.stringify({ type: "webauthn.get", challenge, origin: BASE_URL }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { id: "cred-1", response: { clientDataJSON } };
}
/** A ceremony answer with a well-formed challenge that no row holds: the challenge check refuses it. */
const UNKNOWN_CEREMONY = ceremonyOf(BODY43);

/**
 * A body that parses under the route's schema, for each POST with a body. A
 * value that starts with `$` is a placeholder. A test fills it with a value
 * of its world: an organization id, a mailed token, or a challenge.
 */
const BODIES: { readonly [K in RouteKey]?: Record<string, unknown> } = {
  "POST /sessions/revoke": { id: "s1" },
  "POST /reauth": { password: PASSWORD },
  "POST /user/update": { name: "Ada" },
  // Plan 12i Task 2: a free name that passes the form and the reserved set.
  "POST /user/username": { username: "Ada" },
  "POST /user/change-email": { newEmail: "new@example.com" },
  "POST /user/change-email/confirm": { token: "$emailChangeToken" },
  "POST /user/change-email/verify": { code: "123456" },
  "POST /user/delete/confirm": { token: "$deleteToken" },
  "POST /identities/unlink": { id: "i1" },
  "POST /magic-link/request": { email: "ada@example.com" },
  "POST /magic-link/verify": { token: "$magicToken" },
  "POST /passkey/register/verify": { response: CEREMONY },
  "POST /passkey/authenticate/verify": { response: CEREMONY },
  // Plan 12i Task 8: the passkey-first sign-up. A family that needs a real ceremony makes one.
  "POST /passkey/sign-up/options": { name: "Ana" },
  "POST /passkey/sign-up/verify": { response: CEREMONY },
  "POST /passkeys/delete": { id: "p1" },
  "POST /passkeys/rename": { id: "p1", name: "Key" },
  "POST /password/sign-up": { email: "$newEmail", password: PASSWORD },
  "POST /password/sign-in": { email: "ada@example.com", password: PASSWORD },
  "POST /password/verify": { token: BODY43 },
  "POST /password/verify/code": { email: "ada@example.com", code: "000000" },
  "POST /password/verify/resend": { email: "ada@example.com" },
  "POST /password/reset/request": { email: "ada@example.com" },
  "POST /password/reset": { token: "$resetToken", password: PASSWORD },
  "POST /password/change": { currentPassword: PASSWORD, newPassword: "a new horse battery" },
  "POST /totp/setup": { password: PASSWORD },
  "POST /totp/enable": { code: "000000" },
  "POST /totp/disable": { code: "000000" },
  "POST /totp/backup-codes": { code: "000000" },
  "POST /totp/verify": { challenge: "$challenge", code: "000000" },
  "POST /totp/challenge": { challenge: "$challenge", code: "000000" },
  "POST /second-factor/passkey/enable": { password: PASSWORD, response: CEREMONY },
  "POST /second-factor/passkey/options": { challenge: "$challenge" },
  "POST /second-factor/disable": { method: "email", password: PASSWORD },
  "POST /second-factor/email/enable": { password: PASSWORD },
  "POST /second-factor/email/send": { challenge: "$challenge" },
  "POST /otp/request": { email: "ada@example.com" },
  "POST /otp/verify": { email: "$otpEmail", code: "$otpCode" },
  "POST /otp/reset/request": { email: "ada@example.com" },
  "POST /otp/reset": { email: "$otpEmail", code: "$otpCode", password: PASSWORD },
  // Plan 12i Task 5: the phone routes. A new number for the request and the add.
  "POST /phone/request": { phone: "+14155550100" },
  "POST /phone/verify": { phone: "$phone", code: "$phoneCode" },
  // Plan 12i Task 10: the ID-token route. The nonce is well formed; no row holds it.
  "POST /social/:provider/id-token/nonce": {},
  "POST /social/:provider/id-token": { idToken: "a.b.c", nonce: BODY43 },
  "POST /phone/add": { phone: "+14155550101" },
  "POST /phone/add/verify": { code: "$phoneCode" },
  "POST /phone/remove": {},
  // Plan 12i Task 6: the anonymous routes take an empty body.
  "POST /anonymous/sign-in": {},
  "POST /anonymous/delete": {},
  "POST /handoff/continue": { h: `hs_${BODY43}` },
  "POST /handoff/redeem": { code: BODY43, verifier: BODY43 },
  "POST /organizations/create": { slug: "acme", name: "Acme" },
  "POST /organizations/check-slug": { slug: "acme" },
  // A rename: only a new slug spends the limiter of the slug check.
  "POST /organizations/update": { organizationId: "$org", slug: "acme-co" },
  "POST /organizations/delete": { organizationId: "$org" },
  "POST /organizations/members/add": { organizationId: "$org", userId: "u2", role: "member" },
  "POST /organizations/members/role": { organizationId: "$org", userId: "u2", role: "admin" },
  "POST /organizations/members/remove": { organizationId: "$org", userId: "u2" },
  "POST /organizations/invite": {
    organizationId: "$org",
    email: "bob@example.com",
    role: "member",
  },
  "POST /organizations/invitations/revoke": { organizationId: "$org", invitationId: "i1" },
  "POST /organizations/invitations/accept": { token: "$inviteToken" },
  "POST /organizations/invitations/decline": { token: "$inviteToken" },
  "POST /organizations/active": { organizationId: "$org" },
  "POST /organizations/roles/create": {
    organizationId: "$org",
    name: "editor",
    permissions: { member: ["read"] },
  },
  "POST /organizations/roles/update": { organizationId: "$org", name: "editor", rank: 1 },
  "POST /organizations/roles/delete": { organizationId: "$org", name: "editor" },
  "POST /organizations/teams/create": { organizationId: "$org", name: "Core" },
  "POST /organizations/teams/update": { teamId: "$team", name: "Web" },
  "POST /organizations/teams/delete": { teamId: "$team" },
  "POST /organizations/teams/members/add": { teamId: "$team", userId: "u2" },
  "POST /organizations/teams/members/remove": { teamId: "$team", userId: "u2" },
  "POST /organizations/teams/active": { teamId: "$team" },
  "POST /organizations/tokens": { organizationId: "$org", name: "ci", permissions: {} },
  "POST /organizations/tokens/update": { organizationId: "$org", id: "t1" },
  "POST /organizations/tokens/revoke": { organizationId: "$org", id: "t1" },
  "POST /tokens": { name: "ci" },
  "POST /tokens/revoke": { id: "t1" },
  "POST /tokens/update": { id: "t1" },
  "POST /oauth/register": { redirect_uris: ["https://client.example.com/callback"] },
  "POST /oauth/authorize": { request_id: BODY43, decision: "allow" },
  "POST /oauth/token": { grant_type: "authorization_code", client_id: "client-1" },
  "POST /oauth/revoke": { token: BODY43 },
  "POST /oauth/device_authorization": {
    client_id: "client-1",
    scope: "openid",
    resource: `${BASE_URL}/mcp`,
  },
  "POST /oauth/device": { user_code: "BCDF-GHJK" },
  "POST /oauth/grants/revoke": { clientId: "client-1" },
  // Plan 12d: `$domain` names a domain of the world, so a route with an id reaches its guard.
  "POST /sso/domains/add": { organizationId: "$org", domain: "acme.example" },
  "POST /sso/domains/verify": { id: "$domain" },
  "POST /sso/domains/update": { id: "$domain", includeSubdomains: true },
  "POST /sso/domains/delete": { id: "$domain" },
  // Plan 12d Task 3: `$connection` names a connection of the world.
  "POST /sso/connections/create": {
    organizationId: "$org",
    kind: "oidc",
    label: "Acme",
    issuer: "https://login.idp.example",
    clientId: "acme",
    clientSecret: "acme-secret",
  },
  "POST /sso/connections/update": { id: "$connection", label: "Acme" },
  "POST /sso/connections/delete": { id: "$connection" },
  // Plan 12d Task 4: the discovery at sign-in.
  "POST /sso/discover": { email: "ada@example.com" },
  // Plan 12d Task 9b: `$scimToken` names a SCIM token of the world.
  "POST /scim/tokens/create": { organizationId: "$org", name: "directory" },
  "POST /scim/tokens/revoke": { id: "$scimToken" },
};

/** The query of a GET whose route refuses a request with none. A `$` value is a placeholder too. */
const QUERIES: { readonly [K in RouteKey]?: Record<string, string> } = {
  "GET /handoff/start": { challenge: BODY43, redirect: "example://auth" },
  "GET /organizations/members": { organizationId: "$org" },
  "GET /organizations/invitations": { organizationId: "$org" },
  "GET /organizations/roles": { organizationId: "$org" },
  "GET /organizations/roles/get": { organizationId: "$org", name: "editor" },
  "GET /organizations/teams": { organizationId: "$org" },
  "GET /organizations/teams/members": { teamId: "$team" },
  "GET /organizations/tokens": { organizationId: "$org" },
  "GET /sso/domains": { organizationId: "$org" },
  "GET /sso/connections": { organizationId: "$org" },
  "GET /scim/tokens": { organizationId: "$org" },
  "GET /username/available": { username: "ada" },
};

/** The values of the placeholders of `BODIES` and `QUERIES`, by placeholder. */
type Fills = Record<string, string>;

/** The value of a placeholder that a test does not fill: a well-formed value that names no row. */
const UNFILLED: Fills = {
  $newEmail: "new@example.com",
  $otpEmail: "ada@example.com",
  $otpCode: "123456",
  $magicToken: BODY43,
  $resetToken: BODY43,
  $emailChangeToken: BODY43,
  $deleteToken: BODY43,
  $inviteToken: BODY43,
  $challenge: BODY43,
  $org: "o1",
  $team: "t1",
  $domain: "d1",
  $connection: "c1",
  $scimToken: "k1",
  $phone: "+14155550100",
  $phoneCode: "123456",
};

/** `value` with its placeholder filled from `fills`, or from `UNFILLED`. */
function filled(value: unknown, fills: Fills): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const known = fills[value] ?? UNFILLED[value];
  if (known === undefined) throw new Error(`no value for the placeholder ${value}`);
  return known;
}

/** What a route answered: the status, and the code of a JSON error or of a redirect's error parameter. */
interface Answer {
  status: number;
  code: string | null;
}

async function answerOf(res: Response): Promise<Answer> {
  if (res.status === 302 || res.status === 303) {
    const location = new URL(res.headers.get("location") ?? "", BASE_URL);
    const code = location.searchParams.get(AUTH_ERROR_PARAM) ?? location.searchParams.get("error");
    return { status: res.status, code };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    const body = (await res.json()) as { error?: string };
    return { status: res.status, code: body.error ?? null };
  }
  return { status: res.status, code: null };
}

const entryOf = (key: RouteKey) => {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
  if (!entry) throw new Error(`no entry ${key}`);
  return entry;
};

/** The entry of `key` takes the credential form `form`. */
function takes(key: RouteKey, form: string): boolean {
  return (entryOf(key).auth as readonly string[]).includes(form);
}

/** The routes whose entry declares `code`, in `codes` or `oauthCodes`. */
function declaring(code: string): RouteKey[] {
  return ROUTES.filter(
    (r) =>
      (r.codes as readonly string[]).includes(code) ||
      (r.oauthCodes as readonly string[]).includes(code),
  ).map((r) => `${r.method} ${r.path}` as RouteKey);
}

/**
 * The request of one route from the app: the path with a real provider, the
 * body of the table by its media, the placeholders filled. `own` replaces
 * the body of the table.
 */
function requestOf(
  key: RouteKey,
  headers: Record<string, string>,
  fills: Fills,
  own?: Record<string, unknown>,
): Request {
  const entry = entryOf(key);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(QUERIES[key] ?? {})) query.set(k, String(filled(v, fills)));
  const path = entry.path.replace(":provider", "google");
  const url = `${BASE_URL}/auth${path}${query.size > 0 ? `?${query}` : ""}`;
  if (entry.method === "GET") return new Request(url, { headers });
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(own ?? BODIES[key] ?? {})) body[k] = filled(v, fills);
  const media = CONTRACT[key]?.body?.media ?? ["json"];
  if (media.includes("json"))
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...headers },
      body: JSON.stringify(body),
    });
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, String(v));
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL, ...headers },
    body: params.toString(),
  });
}

/**
 * A world with every feature on. Its limiter allows every request until a
 * test sets `refuse`, so the setup of the test runs the real flows first.
 */
function world(extra: Partial<AuthConfig> = {}) {
  const limiter = { refuse: false, allow: async () => !limiter.refuse };
  const sms = createRecordingSms();
  const auth = makeAuth({
    limiter,
    password: { hash: FAST, uniformSignUp: false },
    // The passkey-first sign-up of plan 12i Task 8.
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL], signUp: true },
    handoff: { schemes: ["example://"] },
    social: SOCIAL,
    organizations: { dynamicRoles: {}, teams: {} },
    oauth: {
      resources: [`${BASE_URL}/mcp`],
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    // A secret with every scope, and the user tools of plan 12f. The hash admits no secret.
    operator: {
      secrets: [
        {
          name: "default",
          secretHash: "0".repeat(64),
          scopes: ["keys", "secrets", "users", "sessions", "audit", "sso"],
        },
      ],
      users: true,
    },
    account: { deleteConfirm: { ttlMinutes: 60 } },
    // The domain and connection routes of plan 12d. No family of this file reaches a resolver.
    sso: { oidc: true, dns: [{ name: "none", txt: async () => [] }] },
    // The SCIM token routes of plan 12d Task 9b.
    scim: {},
    // The username routes of plan 12i Task 2.
    username: {},
    // The phone routes of plan 12i Task 5, on the memory limiter.
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    // The anonymous routes of plan 12i Task 6.
    anonymous: { isolateLimiter: "allow" },
    // The multi-session routes of plan 12i Task 11.
    multiSession: {},
    // The base URL is the trusted origin of the POSTs below; the consent form takes that origin only.
    trustedOrigins: [BASE_URL],
    ...extra,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  /** The token of the last mail that the fake mail port recorded. */
  const lastToken = () => tokenFromMail(auth.mail.at(-1)?.text ?? "");
  /** The six-digit code of the last mail. */
  const lastCode = () => {
    const m = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error("no code in mail");
    return m[1];
  };
  /** The invitation token of the last mail: its link carries `invitation=`. */
  const lastInvitation = () => {
    const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(auth.mail.at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error("no invitation in mail");
    return m[1];
  };
  /** The code of the last SMS: the default text starts with it (plan 12i Task 5). */
  const lastSms = () => {
    const m = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error("no code in the SMS");
    return m[1];
  };
  return { auth, limiter, handle, cookie, lastToken, lastCode, lastInvitation, lastSms };
}
type World = ReturnType<typeof world>;

/** A fresh challenge of a user with the email method on, from a real password sign-in. */
async function challengeOf(w: World, email: string): Promise<string> {
  const r = await passwordSignIn(w.auth.config, {
    email,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!r.ok || !("twoFactor" in r.value)) throw new Error("the sign-in answered no challenge");
  return r.value.twoFactor.challenge;
}

/**
 * The body of a passkey-first sign-up verify (plan 12i Task 8): the options
 * of `config`, and a new authenticator's registration of them.
 */
async function signUpCeremony(config: World["auth"]["config"]): Promise<Record<string, unknown>> {
  const options = must(await passkeySignUpOptions(config, { name: "Ana", ip: null }));
  const soft = await SoftAuthenticator.create({ rpID: "api.example.com", origin: BASE_URL });
  return { response: await soft.register(options.challenge, fromBase64Url(options.user.id)) };
}

/** `fn` answered ok, or the test stops with its code. */
function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(`the setup answered ${r.code}`);
  return r.value;
}

/** The answer of one route to one body, with the placeholders filled. */
async function call(
  w: World,
  key: RouteKey,
  headers: Record<string, string>,
  own?: Record<string, unknown>,
  fills: Fills = {},
): Promise<Answer> {
  return answerOf(await w.handle(requestOf(key, headers, fills, own)));
}

/** The answers of the routes, by key. `headersOf` gives the credential of each route. */
async function probe(
  w: World,
  routes: RouteKey[],
  headersOf: (key: RouteKey) => Record<string, string>,
  fills: Fills = {},
): Promise<Record<string, Answer>> {
  const results: Record<string, Answer> = {};
  for (const key of routes)
    results[key] = await answerOf(await w.handle(requestOf(key, headersOf(key), fills)));
  return results;
}

/**
 * The routes whose answer is not the code with `status`, with what they
 * answered: empty when every route answers it. A route in `redirects`
 * carries the code in a 302 to the app.
 */
function unlike(
  results: Record<string, Answer>,
  code: string,
  status: number,
  redirects: readonly RouteKey[] = [],
): Record<string, Answer> {
  const differing: Record<string, Answer> = {};
  for (const [key, got] of Object.entries(results)) {
    const want = redirects.includes(key as RouteKey) ? 302 : status;
    if (got.status !== want || got.code !== code) differing[key] = got;
  }
  return differing;
}

describe("the codes that one world answers on every route (plan 11g)", () => {
  it("holds each body of the table to the route's schema", () => {
    for (const [key, body] of Object.entries(BODIES)) {
      const schema = CONTRACT[key]?.body?.schema;
      expect(schema, `${key} has a body in the table and no body schema`).toBeDefined();
      expect(schema?.safeParse(body).success, `${key}: the body does not parse`).toBe(true);
    }
  });

  it("answers 429 rate_limited on every route that declares it when the limiter refuses", async () => {
    const w = world();
    const { config } = w.auth;
    // A verified user with a password, an organization, and the email method on.
    const me = await verifiedSession(w.auth, "ada@example.com");
    const org = must(
      await createOrganization(config, { user: me.user, slug: "acme", name: "Acme" }),
    );
    must(await requestPasswordReset(config, { email: emailOf(me.user), ip: null }));
    const resetToken = w.lastToken();
    must(await requestEmailChange(config, { session: me, newEmail: "ada2@example.com" }));
    const emailChangeToken = w.lastToken();
    must(await requestAccountDelete(config, { session: me, ip: null, userAgent: null }));
    const deleteToken = w.lastToken();
    const jwt = must(
      await mintSessionJwt(config, { userId: me.user.id, sessionId: me.session.id }),
    );
    must(await enableEmailMethod(config, { session: me, password: PASSWORD }));
    const challenge = await challengeOf(w, emailOf(me.user));
    // A token with a window (plan 12k): its window is the limiter call of GET /tokens/current.
    const windowed = must(
      await createApiToken(config, {
        user: me.user,
        name: "windowed",
        rateLimit: { seconds: 60, max: 100 },
      }),
    );
    // The same for GET /organizations/tokens/current, with a token of the organization.
    const orgWindowed = must(
      await createOrganizationToken(config, {
        user: me.user,
        organizationId: org.organization.id,
        name: "windowed",
        permissions: {},
        rateLimit: { seconds: 60, max: 100 },
      }),
    );
    const fills: Fills = {
      $org: org.organization.id,
      $resetToken: resetToken,
      $emailChangeToken: emailChangeToken,
      $deleteToken: deleteToken,
      $challenge: challenge,
    };
    // The impersonation start counts after the operator guard, so it needs a
    // platform operator: operator-impersonation.test.ts answers its 429.
    const routes = declaring("rate_limited").filter((key) => key !== "POST /operator/impersonate");
    expect(routes.length).toBeGreaterThan(0);
    // The anonymous delete counts for an anonymous session only (plan 12i Task 6).
    const anonymous = must(
      await signInAnonymous(config, { current: null, ip: null, userAgent: null }),
    );
    w.limiter.refuse = true;
    const results = await probe(
      w,
      routes,
      (key) =>
        key === "POST /anonymous/delete"
          ? w.cookie(anonymous.token)
          : // The anonymous sign-in counts a request with no session only.
            key === "POST /anonymous/sign-in"
            ? {}
            : key === "POST /token/live"
              ? { authorization: `Bearer ${jwt.token}` }
              : key === "GET /tokens/current"
                ? { authorization: `Bearer ${windowed.token}` }
                : key === "GET /organizations/tokens/current"
                  ? { authorization: `Bearer ${orgWindowed.token}` }
                  : // The device page counts a request with no session only.
                    key === "GET /oauth/device"
                    ? {}
                    : // The operator user tools count a secret call before the compare
                      // (plan 12f), and so does the override of plan 12d.
                      entryOf(key).feature === "operatorUsers" ||
                        entryOf(key).feature === "operatorSso"
                      ? { authorization: `Operator ${"x".repeat(32)}` }
                      : w.cookie(me.token),
      fills,
    );
    // The four routes that carry the code in a redirect to the app.
    const redirects: RouteKey[] = [
      "GET /social/:provider/start",
      "POST /totp/challenge",
      "GET /sso/:connectionId/start",
      "POST /sso/:connectionId/acs",
    ];
    expect(unlike(results, "rate_limited", 429, redirects)).toEqual({});
  });

  it("answers 403 email_unverified on every session route that declares it to an unverified user", async () => {
    const w = world();
    const { config } = w.auth;
    // Pat signed up with a password and did not use the link. Ada, verified, invites Pat.
    const pat = upSession(
      must(
        await passwordSignUp(config, {
          email: "pat@example.com",
          password: PASSWORD,
          ip: null,
          userAgent: null,
        }),
      ),
    );
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const org = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    must(
      await inviteMember(config, {
        user: ada.user,
        organizationId: org.organization.id,
        email: "pat@example.com",
        role: "member",
      }),
    );
    const fills: Fills = { $org: org.organization.id, $inviteToken: w.lastInvitation() };
    // The operator user tools answer it for the target, not for the caller: operator-routes.test.ts drives it.
    const routes = declaring("email_unverified").filter(
      (key) => takes(key, "session") && entryOf(key).feature !== "operatorUsers",
    );
    expect(routes.length).toBeGreaterThan(0);
    const results = await probe(w, routes, () => w.cookie(pat.token), fills);
    expect(unlike(results, "email_unverified", 403)).toEqual({});
  });

  it("answers 403 forbidden_rank on every route that declares it to a user outside the organization", async () => {
    const w = world();
    const { config } = w.auth;
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const org = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    // A team of the organization, so each team route reaches the rank check (plan 12k Task 5).
    const team = must(
      await createTeam(config, {
        user: ada.user,
        organizationId: org.organization.id,
        name: "Core",
      }),
    );
    const carol = await verifiedSession(w.auth, "carol@example.com");
    // POST /tokens answers it to a member whose role lacks the token's set (plan 12k Task 7);
    // a user outside answers not_found there. token-scope.test.ts proves the route answer.
    const routes = declaring("forbidden_rank").filter((key) => key !== "POST /tokens");
    expect(routes.length).toBeGreaterThan(0);
    // A domain of the organization, so each domain route with an id reaches the guard (plan 12d).
    const domain = must(
      await addDomain(
        config,
        { kind: "app", name: "route-codes" },
        {
          organizationId: org.organization.id,
          domain: "acme.example",
        },
      ),
    );
    // A connection of the organization, for the connection routes with an id (plan 12d Task 3).
    const connection = must(
      await createConnection(
        config,
        { kind: "app", name: "route-codes" },
        {
          organizationId: org.organization.id,
          kind: "oidc",
          label: "Acme",
          issuer: "https://login.idp.example",
          clientId: "acme",
          clientSecret: "acme-secret",
        },
      ),
    );
    // A SCIM token of the organization, for the revoke (plan 12d Task 9b).
    const scimToken = must(
      await createScimToken(
        config,
        { kind: "app", name: "route-codes" },
        { organizationId: org.organization.id, name: "directory" },
      ),
    );
    const results = await probe(w, routes, () => w.cookie(carol.token), {
      $org: org.organization.id,
      $team: team.id,
      $domain: domain.id,
      $connection: connection.id,
      $scimToken: scimToken.id,
    });
    expect(unlike(results, "forbidden_rank", 403)).toEqual({});
  });

  it("answers 503 captcha_unavailable on every route that declares it when the port cannot answer", async () => {
    const w = world({
      captcha: {
        port: {
          verify: async () => "unavailable",
          // The sign-in page of the handoff and the consent needs the widget of a gated flow.
          page: {
            scriptSrc: "https://captcha.example/widget.js",
            widgetHtml: "<div></div>",
            responseField: "x-captcha-response",
            cspSources: ["https://captcha.example"],
          },
        },
        flows: [...CAPTCHA_FLOWS],
        onUnavailable: "refuse",
      },
    });
    const routes = declaring("captcha_unavailable");
    expect(routes.length).toBeGreaterThan(0);
    const results = await probe(w, routes, () => ({ [CAPTCHA_HEADER]: "tok" }));
    expect(unlike(results, "captcha_unavailable", 503)).toEqual({});
  });

  it("answers 403 sign_up_closed on every route that declares it, but a social callback, when sign-up is off", async () => {
    const w = world({ signUp: false });
    const { config } = w.auth;
    const email = "new@example.com";
    // The mail of each way in: a request mails for an unknown address too, so the address learns nothing.
    must(await requestMagicLink(config, { email, ip: null }));
    const magicToken = w.lastToken();
    must(await requestPasswordReset(config, { email, ip: null }));
    const resetToken = w.lastToken();
    must(await requestEmailOtp(config, { email, ip: null }));
    const otpCode = w.lastCode();
    // A phone code to a new number: `phone.signUp` sends it, and the verify meets the closed sign-up (plan 12i Task 5).
    must(await requestPhone(config, { phone: "+14155550199", ip: null }));
    const fills: Fills = {
      $newEmail: email,
      $otpEmail: email,
      $otpCode: otpCode,
      $magicToken: magicToken,
      $resetToken: resetToken,
      $phone: "+14155550199",
      $phoneCode: w.lastSms(),
    };
    // The callback of a provider needs a provider exchange: sign-up-rule.test.ts proves it on the engine.
    // The SSO callback needs an IdP exchange: sso/resolve.test.ts proves it through the route (plan 12d).
    // The SAML ACS needs a signed Response of a start; it runs the same resolveSsoUser (plan 12d Task 8).
    const callbacks: RouteKey[] = [
      "GET /social/:provider/callback",
      "POST /social/apple/callback",
      // The ID-token route needs a token of a key set: id-token.test.ts proves it (plan 12i Task 10).
      "POST /social/:provider/id-token",
      "GET /sso/:connectionId/callback",
      "POST /sso/:connectionId/acs",
    ];
    const routes = declaring("sign_up_closed").filter((key) => !callbacks.includes(key));
    expect(routes.length).toBeGreaterThan(0);
    const otpReset = "POST /otp/reset";
    // The reset code is one mail of its own, after the sign-in code is spent by nothing: the last mail wins.
    const first = await probe(
      w,
      routes.filter((key) => key !== otpReset && key !== "POST /passkey/sign-up/verify"),
      () => ({}),
      fills,
    );
    must(await requestResetOtp(config, { email, ip: null }));
    const second = await probe(w, [otpReset], () => ({}), { ...fills, $otpCode: w.lastCode() });
    // The passkey-first sign-up verify (plan 12i Task 8): options made while the sign-up was open.
    const signUp = "POST /passkey/sign-up/verify";
    const third = {
      [signUp]: await call(w, signUp, {}, await signUpCeremony({ ...config, signUp: "open" })),
    };
    expect(unlike({ ...first, ...second, ...third }, "sign_up_closed", 403)).toEqual({});
  });
});

/**
 * The codes of one route each (plan 11g Task 5). Each test builds the one
 * state that the route refuses, through the engine or the routes. It reads
 * the code on the wire, so the answer recorder sees it on that route.
 */
describe("the codes of one route (plan 11g)", () => {
  it("POST /tokens answers token_limit at the cap", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    for (let i = 0; i < API_TOKEN_CAP; i++)
      must(await createApiToken(w.auth.config, { user: me.user, name: `t${i}` }));
    expect(await call(w, "POST /tokens", w.cookie(me.token))).toEqual({
      status: 409,
      code: "token_limit",
    });
  });

  it("POST /organizations/tokens answers organization_token_limit at the cap", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const org = must(
      await createOrganization(w.auth.config, { user: me.user, slug: "acme", name: "Acme" }),
    );
    for (let i = 0; i < ORGANIZATION_TOKEN_CAP; i++)
      must(
        await createOrganizationToken(w.auth.config, {
          user: me.user,
          organizationId: org.organization.id,
          name: `t${i}`,
          permissions: {},
        }),
      );
    expect(
      await call(w, "POST /organizations/tokens", w.cookie(me.token), undefined, {
        $org: org.organization.id,
      }),
    ).toEqual({ status: 409, code: "organization_token_limit" });
  });

  it("the organization routes answer organization_limit, member_limit, and invitation_limit at each limit", async () => {
    const w = world({
      organizations: {
        limits: { perUser: 1, membersPerOrganization: 2, pendingInvitationsPerOrganization: 3 },
      },
    });
    const { config } = w.auth;
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const carol = await verifiedSession(w.auth, "carol@example.com");
    const org = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    const fills: Fills = { $org: org.organization.id };
    const cookie = w.cookie(ada.token);
    expect(
      await call(w, "POST /organizations/create", cookie, { slug: "beta", name: "Beta" }),
    ).toEqual({ status: 409, code: "organization_limit" });
    const add = (userId: string) =>
      call(
        w,
        "POST /organizations/members/add",
        cookie,
        { organizationId: "$org", userId, role: "member" },
        fills,
      );
    expect(await add(bob.user.id)).toEqual({ status: 200, code: null });
    expect(await add(bob.user.id)).toEqual({ status: 409, code: "already_member" });
    expect(await add(carol.user.id)).toEqual({ status: 409, code: "member_limit" });
    const invite = (email: string) =>
      call(
        w,
        "POST /organizations/invite",
        cookie,
        { organizationId: "$org", email, role: "member" },
        fills,
      );
    const dan = await verifiedSession(w.auth, "dan@example.com");
    expect(await invite(emailOf(dan.user))).toEqual({ status: 200, code: null });
    const danToken = w.lastInvitation();
    expect(await invite("eve@example.com")).toEqual({ status: 200, code: null });
    expect(await invite("frank@example.com")).toEqual({ status: 200, code: null });
    expect(await invite("gus@example.com")).toEqual({ status: 409, code: "invitation_limit" });
    expect(
      await call(w, "POST /organizations/invitations/accept", w.cookie(dan.token), {
        token: danToken,
      }),
    ).toEqual({ status: 409, code: "member_limit" });
  });

  it("the organization routes answer slug_reserved and slug_taken on a create and an update", async () => {
    const w = world({ organizations: { reservedSlugs: ["reserved"] } });
    const { config } = w.auth;
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const acme = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    must(await createOrganization(config, { user: ada.user, slug: "beta", name: "Beta" }));
    const cookie = w.cookie(ada.token);
    const create = (slug: string) =>
      call(w, "POST /organizations/create", cookie, { slug, name: "X" });
    expect(await create("reserved")).toEqual({ status: 400, code: "slug_reserved" });
    expect(await create("beta")).toEqual({ status: 409, code: "slug_taken" });
    const update = (slug: string) =>
      call(w, "POST /organizations/update", cookie, { organizationId: acme.organization.id, slug });
    expect(await update("reserved")).toEqual({ status: 400, code: "slug_reserved" });
    expect(await update("beta")).toEqual({ status: 409, code: "slug_taken" });
  });

  it("POST /organizations/delete answers slug_reserved for the platform organization", async () => {
    const w = world({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
    });
    const { root, platformOrg } = await seedPlatform(w.auth);
    const session = await createSession(w.auth.config, {
      userId: root.id,
      ip: null,
      userAgent: null,
    });
    expect(
      await call(w, "POST /organizations/delete", w.cookie(session.token), {
        organizationId: platformOrg.id,
      }),
    ).toEqual({ status: 400, code: "slug_reserved" });
  });

  it("the member routes answer last_owner when the sole owner leaves or steps down", async () => {
    const w = world();
    const { config } = w.auth;
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const org = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    const cookie = w.cookie(ada.token);
    const body = { organizationId: org.organization.id, userId: ada.user.id };
    must(
      await addMember(config, {
        user: ada.user,
        organizationId: org.organization.id,
        userId: bob.user.id,
        role: "member",
      }),
    );
    expect(
      await call(w, "POST /organizations/members/role", cookie, { ...body, role: "member" }),
    ).toEqual({ status: 409, code: "last_owner" });
    expect(await call(w, "POST /organizations/members/remove", cookie, body)).toEqual({
      status: 409,
      code: "last_owner",
    });
  });

  it("POST /user/delete/confirm answers sole_owner when the user became the sole owner after the request", async () => {
    const w = world();
    const { config } = w.auth;
    const ada = await verifiedSession(w.auth, "ada@example.com");
    must(await requestAccountDelete(config, { session: ada, ip: null, userAgent: null }));
    const token = w.lastToken();
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const org = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    must(
      await addMember(config, {
        user: ada.user,
        organizationId: org.organization.id,
        userId: bob.user.id,
        role: "member",
      }),
    );
    expect(await call(w, "POST /user/delete/confirm", w.cookie(ada.token), { token })).toEqual({
      status: 409,
      code: "sole_owner",
    });
  });

  it("the password routes answer password_policy, password_breached, and breach_check_unavailable", async () => {
    const breach = { answer: false as boolean | "unavailable" };
    const w = world({
      password: { hash: FAST, uniformSignUp: false, breachCheck: async () => breach.answer },
    });
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const cookie = w.cookie(ada.token);
    const change = (newPassword: string) =>
      call(w, "POST /password/change", cookie, { currentPassword: PASSWORD, newPassword });
    expect(await change("short")).toEqual({ status: 400, code: "password_policy" });
    breach.answer = true;
    expect(await change("a new horse battery")).toEqual({ status: 400, code: "password_breached" });
    expect(
      await call(w, "POST /password/sign-up", {}, { email: "new@example.com", password: PASSWORD }),
    ).toEqual({ status: 400, code: "password_breached" });
    must(await requestPasswordReset(w.auth.config, { email: emailOf(ada.user), ip: null }));
    expect(
      await call(
        w,
        "POST /password/reset",
        {},
        { token: w.lastToken(), password: "a new horse battery" },
      ),
    ).toEqual({ status: 400, code: "password_breached" });
    breach.answer = "unavailable";
    expect(await change("a new horse battery")).toEqual({
      status: 503,
      code: "breach_check_unavailable",
    });
    must(await requestResetOtp(w.auth.config, { email: emailOf(ada.user), ip: null }));
    expect(
      await call(
        w,
        "POST /otp/reset",
        {},
        { email: ada.user.email, code: w.lastCode(), password: "a new horse battery" },
      ),
    ).toEqual({ status: 503, code: "breach_check_unavailable" });
  });

  it("POST /password/sign-up answers email_taken_unverified for an unverified user with no password", async () => {
    const w = world();
    // A social sign-up with an unverified provider address leaves this row: no password, not verified.
    const now = w.auth.clock.now();
    await w.auth.storage.create("user", {
      id: "u-pat",
      email: "pat@example.com",
      emailVerified: false,
      name: null,
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
    const body = { email: "pat@example.com", password: PASSWORD };
    expect(await call(w, "POST /password/sign-up", {}, body)).toEqual({
      status: 409,
      code: "email_taken_unverified",
    });
  });

  it("the TOTP routes answer totp_enabled, totp_not_enabled, invalid_code, and too_many_attempts", async () => {
    const w = world();
    const me = await enrolled(w.auth, "ada@example.com");
    const cookie = w.cookie(me.session.token);
    const wrong = wrongFor(await codeNow(w.auth, me.secret));
    expect(await call(w, "POST /totp/setup", cookie, { password: PASSWORD })).toEqual({
      status: 409,
      code: "totp_enabled",
    });
    expect(await call(w, "POST /totp/enable", cookie, { code: wrong })).toEqual({
      status: 409,
      code: "totp_enabled",
    });
    expect(await call(w, "POST /totp/disable", cookie, { code: wrong })).toEqual({
      status: 400,
      code: "invalid_code",
    });
    expect(await call(w, "POST /totp/backup-codes", cookie, { code: wrong })).toEqual({
      status: 400,
      code: "invalid_code",
    });
    const bob = await verifiedSession(w.auth, "bob@example.com");
    expect(await call(w, "POST /totp/enable", w.cookie(bob.token), { code: wrong })).toEqual({
      status: 400,
      code: "totp_not_enabled",
    });
    // The sign-in challenge: a wrong code each time, until the challenge is spent.
    const challenge = await challengeOf(w, emailOf(me.user));
    const verify = () => call(w, "POST /totp/verify", {}, { challenge, code: wrong });
    expect(await verify()).toEqual({ status: 400, code: "invalid_code" });
    const codes: string[] = [];
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) codes.push((await verify()).code ?? "");
    expect(codes).toContain("too_many_attempts");
    // The form of the challenge page carries each code in a redirect.
    const page = await challengeOf(w, emailOf(me.user));
    const form = () => call(w, "POST /totp/challenge", {}, { challenge: page, code: wrong });
    const formCodes: Answer[] = [];
    for (let i = 0; i <= CHALLENGE_MAX_ATTEMPTS; i++) formCodes.push(await form());
    expect(formCodes).toContainEqual({ status: 302, code: "too_many_attempts" });
  });

  it("the second-factor routes answer invalid_credentials, totp_not_enabled, and passkey_failed", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const cookie = w.cookie(me.token);
    const refused = { status: 401, code: "invalid_credentials" };
    expect(
      await call(w, "POST /second-factor/disable", cookie, { method: "email", password: "wrong" }),
    ).toEqual(refused);
    expect(
      await call(w, "POST /second-factor/email/enable", cookie, { password: "wrong" }),
    ).toEqual(refused);
    expect(
      await call(w, "POST /second-factor/passkey/enable", cookie, {
        password: "wrong",
        response: CEREMONY,
      }),
    ).toEqual(refused);
    expect(
      await call(w, "POST /second-factor/disable", cookie, { method: "email", password: PASSWORD }),
    ).toEqual({ status: 400, code: "totp_not_enabled" });
    expect(
      await call(w, "POST /second-factor/passkey/enable", cookie, {
        password: PASSWORD,
        response: CEREMONY,
      }),
    ).toEqual({ status: 400, code: "passkey_failed" });
  });

  it("POST /reauth answers invalid_code, too_many_attempts, invalid_token, passkey_failed, and token_expired", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const cookie = w.cookie(me.token);
    must(await requestReauthCode(w.auth.config, { session: me }));
    const code = () => call(w, "POST /reauth", cookie, { emailCode: "000000" });
    expect(await code()).toEqual({ status: 400, code: "invalid_code" });
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) codes.push((await code()).code ?? "");
    expect(codes).toContain("too_many_attempts");
    // A client data with no challenge, and one with a challenge that no row holds: both refuse the token.
    for (const passkey of [CEREMONY, UNKNOWN_CEREMONY])
      expect(await call(w, "POST /reauth", cookie, { passkey })).toEqual({
        status: 400,
        code: "invalid_token",
      });
    // A real challenge with an assertion that no authenticator signed, then one past its five minutes.
    const options = async () => {
      const res = await w.handle(requestOf("POST /reauth/passkey/options", cookie, {}));
      const body = (await res.json()) as { challenge?: string; error?: string };
      expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined });
      return body.challenge ?? "";
    };
    expect(await call(w, "POST /reauth", cookie, { passkey: ceremonyOf(await options()) })).toEqual(
      {
        status: 400,
        code: "passkey_failed",
      },
    );
    const stale = await options();
    w.auth.clock.advance(6 * 60_000);
    expect(await call(w, "POST /reauth", cookie, { passkey: ceremonyOf(stale) })).toEqual({
      status: 400,
      code: "token_expired",
    });
  });

  // Plan 12i Task 9: the sign-in answers passkey_unknown, because no row holds the id `cred-1`.
  it("the passkey ceremonies answer passkey_failed and passkey_unknown to an assertion that no authenticator signed, and token_expired after five minutes", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const cookie = w.cookie(me.token);
    const challengeOfOptions = async (key: RouteKey, headers: Record<string, string>) => {
      const res = await w.handle(requestOf(key, headers, {}));
      const body = (await res.json()) as { challenge?: string; error?: string };
      expect({ key, status: res.status, error: body.error }).toEqual({
        key,
        status: 200,
        error: undefined,
      });
      return body.challenge ?? "";
    };
    const register = await challengeOfOptions("POST /passkey/register/options", cookie);
    expect(
      await call(w, "POST /passkey/register/verify", cookie, { response: ceremonyOf(register) }),
    ).toEqual({ status: 400, code: "passkey_failed" });
    const signIn = await challengeOfOptions("POST /passkey/authenticate/options", {});
    expect(
      await call(w, "POST /passkey/authenticate/verify", {}, { response: ceremonyOf(signIn) }),
    ).toEqual({ status: 400, code: "passkey_unknown" });
    const staleRegister = await challengeOfOptions("POST /passkey/register/options", cookie);
    const staleSignIn = await challengeOfOptions("POST /passkey/authenticate/options", {});
    w.auth.clock.advance(6 * 60_000);
    expect(
      await call(w, "POST /passkey/register/verify", cookie, {
        response: ceremonyOf(staleRegister),
      }),
    ).toEqual({ status: 400, code: "token_expired" });
    expect(
      await call(w, "POST /passkey/authenticate/verify", {}, { response: ceremonyOf(staleSignIn) }),
    ).toEqual({ status: 400, code: "token_expired" });
  });

  it("GET /token answers hook_failed when the claims hook throws", async () => {
    const w = world({
      jwtMint: {
        claims: () => {
          throw new Error("down");
        },
      },
    });
    const me = await verifiedSession(w.auth, "ada@example.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await call(w, "GET /token", w.cookie(me.token))).toEqual({
      status: 500,
      code: "hook_failed",
    });
    log.mockRestore();
  });
});

/**
 * The routes that declare a hook code and that this file does not drive.
 * The provider callbacks need a provider exchange, the passkey sign-in a
 * registered passkey, and the unlink a linked identity. session-hooks.test.ts,
 * link.test.ts, and identities.test.ts prove the hook on the engine path.
 */
const HOOK_ROUTES_ELSEWHERE: readonly RouteKey[] = [
  "GET /social/:provider/callback",
  "POST /social/apple/callback",
  // The ID-token route needs a token of a key set: id-token.test.ts arms the hooks (plan 12i Task 10).
  "POST /social/:provider/id-token",
  "POST /passkey/authenticate/verify",
  "POST /identities/unlink",
  // The claims hook of the JWT: its own test above.
  "GET /token",
  // The operator writes of plan 12f: operator-routes.test.ts arms hooks.operator.beforeAction on each.
  "POST /operator/users/ban",
  "POST /operator/users/unban",
  "POST /operator/users/platform-role",
  "POST /operator/users/second-factor/disable",
  "POST /operator/users/create-admin",
  "POST /operator/sessions/end-user",
  "POST /operator/sessions/end-all",
  // The impersonation needs a platform operator and an impersonation session:
  // operator-impersonation.test.ts drives both hook codes of each route.
  "POST /operator/impersonate",
  "POST /operator/impersonate/stop",
  // The override of plan 12d runs through operatorAct: sso/domain-routes.test.ts arms beforeAction.
  "POST /operator/sso/enforce-off",
  // The SSO callback needs an IdP exchange: sso/resolve.test.ts drives hooks.sso.beforeSignIn (plan 12d).
  "GET /sso/:connectionId/callback",
  // The SAML ACS needs a signed Response of a start, and it runs the same resolveSsoUser (plan 12d Task 8).
  "POST /sso/:connectionId/acs",
  // The sign-up code needs verifyBy code: password-verify-code.test.ts drives both hook codes (plan 12i Task 20).
  "POST /password/verify/code",
];

/** A world whose before hooks all refuse, or all throw, once `armed`. The setup runs before. */
function hookWorld(mode: "refuse" | "throw", extra: Partial<AuthConfig> = {}) {
  const armed = { on: false };
  const guard = () => {
    if (!armed.on) return;
    if (mode === "refuse") throw hookRefusal("Not now.");
    throw new Error("down");
  };
  const w = world({
    ...extra,
    hooks: {
      user: { beforeCreate: guard, beforeUpdate: guard, beforeDelete: guard, beforeVerify: guard },
      session: { beforeCreate: guard },
      organization: {
        beforeCreate: guard,
        beforeUpdate: guard,
        beforeDelete: guard,
        beforeAddMember: guard,
        beforeUpdateMemberRole: guard,
        beforeRemoveMember: guard,
        beforeInvite: guard,
        beforeCreateTeam: guard,
        beforeUpdateTeam: guard,
        beforeDeleteTeam: guard,
        beforeAddTeamMember: guard,
        beforeRemoveTeamMember: guard,
      },
      identity: { beforeLink: guard, beforeUnlink: guard },
    },
  });
  return { ...w, armed };
}

/** The flows of every hook route, run before the hooks are armed: the tokens, codes, and ids each body needs. */
async function hookFlows(w: ReturnType<typeof hookWorld>) {
  const { config } = w.auth;
  const ada = await verifiedSession(w.auth, "ada@example.com");
  const bob = await verifiedSession(w.auth, "bob@example.com");
  const carol = await verifiedSession(w.auth, "carol@example.com");
  const dan = await verifiedSession(w.auth, "dan@example.com");
  const org = must(
    await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
  );
  const organizationId = org.organization.id;
  must(
    await addMember(config, {
      user: ada.user,
      organizationId,
      userId: carol.user.id,
      role: "member",
    }),
  );
  must(
    await inviteMember(config, {
      user: ada.user,
      organizationId,
      email: emailOf(dan.user),
      role: "member",
    }),
  );
  const inviteToken = w.lastInvitation();
  // Two teams (plan 12k Task 5): carol is in the first, for the removal; the second has room for the add.
  const team = must(await createTeam(config, { user: ada.user, organizationId, name: "Core" }));
  const empty = must(await createTeam(config, { user: ada.user, organizationId, name: "Web" }));
  must(await addTeamMember(config, { user: ada.user, teamId: team.id, userId: carol.user.id }));
  must(await requestMagicLink(config, { email: emailOf(ada.user), ip: null }));
  const magicToken = w.lastToken();
  must(await requestEmailOtp(config, { email: emailOf(ada.user), ip: null }));
  const otpCode = w.lastCode();
  must(await requestResetOtp(config, { email: emailOf(ada.user), ip: null }));
  const resetCode = w.lastCode();
  must(await requestPasswordReset(config, { email: emailOf(ada.user), ip: null }));
  const resetToken = w.lastToken();
  must(
    await passwordSignUp(config, {
      email: "pat@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    }),
  );
  const verifyToken = w.lastToken();
  must(
    await requestEmailChange(config, {
      session: ada,
      newEmail: "ada2@example.com",
      method: "code",
    }),
  );
  const changeCode = w.lastCode();
  must(await requestEmailChange(config, { session: bob, newEmail: "bob2@example.com" }));
  const changeToken = w.lastToken();
  // Bob owns no organization, so the delete rule lets the request and the confirm through to the hook.
  must(await requestAccountDelete(config, { session: bob, ip: null, userAgent: null }));
  const deleteToken = w.lastToken();
  const { verifier, challenge } = await pkce();
  const handoff = must(
    await startHandoff(config, { challenge, redirect: "example://auth", ip: null }),
  );
  const landed = must(
    await continueHandoff(config, {
      handoffId: handoff.handoffId,
      userId: ada.user.id,
      sessionId: ada.session.id,
    }),
  );
  const handoffCode = new URL(landed.location).searchParams.get("code") ?? "";
  // One enrolled user per TOTP route: a code passes once, and the first route spends it.
  const totp = await enrolled(w.auth, "totp@example.com");
  const totpChallenge = await challengeOf(w, emailOf(totp.user));
  const totpCode = await codeNow(w.auth, totp.secret);
  const totpForm = await enrolled(w.auth, "totp-form@example.com");
  const formChallenge = await challengeOf(w, emailOf(totpForm.user));
  const formCode = await codeNow(w.auth, totpForm.secret);
  // Plan 12i Task 5: ada holds a phone set by a code, and has a live add code for a second number.
  const phone = "+14155550100";
  must(await addPhone(config, { session: ada, phone, ip: null }));
  must(
    await verifyAddPhone(config, { session: ada, code: w.lastSms(), ip: null, userAgent: null }),
  );
  must(await addPhone(config, { session: ada, phone: "+14155550101", ip: null }));
  const addCode = w.lastSms();
  must(await requestPhone(config, { phone, ip: null }));
  const signInCode = w.lastSms();
  // Plan 12i Task 6: an anonymous session for the delete; the sign-in takes no session.
  const anonymous = must(
    await signInAnonymous(config, { current: null, ip: null, userAgent: null }),
  );
  // Plan 12i Task 8: a passkey-first sign-up runs user.beforeCreate and the session hook.
  const signUp = await signUpCeremony(config);
  const bodies: { readonly [K in RouteKey]?: Record<string, unknown> } = {
    "POST /passkey/sign-up/verify": signUp,
    "POST /anonymous/sign-in": {},
    "POST /anonymous/delete": {},
    "POST /phone/verify": { phone, code: signInCode },
    "POST /phone/add/verify": { code: addCode },
    "POST /phone/remove": {},
    "POST /password/sign-in": { email: ada.user.email, password: PASSWORD },
    "POST /password/sign-up": { email: "new@example.com", password: PASSWORD },
    "POST /password/verify": { token: verifyToken },
    "POST /password/reset": { token: resetToken, password: "a new horse battery" },
    "POST /magic-link/verify": { token: magicToken },
    "POST /otp/verify": { email: ada.user.email, code: otpCode },
    "POST /otp/reset": { email: ada.user.email, code: resetCode, password: "a new horse battery" },
    "POST /handoff/redeem": { code: handoffCode, verifier },
    "POST /totp/verify": { challenge: totpChallenge, code: totpCode },
    "POST /totp/challenge": { challenge: formChallenge, code: formCode },
    "POST /user/update": { name: "Ada" },
    "POST /user/username": { username: "Ada" },
    "POST /user/change-email/verify": { code: changeCode },
    "POST /user/change-email/confirm": { token: changeToken },
    "POST /user/delete/confirm": { token: deleteToken },
    "POST /organizations/create": { slug: "beta", name: "Beta" },
    "POST /organizations/update": { organizationId, name: "Acme Co" },
    "POST /organizations/delete": { organizationId },
    "POST /organizations/members/add": { organizationId, userId: bob.user.id, role: "member" },
    "POST /organizations/members/role": { organizationId, userId: carol.user.id, role: "admin" },
    "POST /organizations/members/remove": { organizationId, userId: carol.user.id },
    "POST /organizations/invite": { organizationId, email: "eve@example.com", role: "member" },
    "POST /organizations/invitations/accept": { token: inviteToken },
    "POST /organizations/teams/create": { organizationId, name: "Ops" },
    "POST /organizations/teams/update": { teamId: team.id, name: "Platform" },
    "POST /organizations/teams/delete": { teamId: team.id },
    "POST /organizations/teams/members/add": { teamId: empty.id, userId: carol.user.id },
    "POST /organizations/teams/members/remove": { teamId: team.id, userId: carol.user.id },
  };
  const headersOf = (key: RouteKey): Record<string, string> => {
    if (key === "POST /organizations/invitations/accept") return w.cookie(dan.token);
    if (key === "POST /user/delete/confirm") return w.cookie(bob.token);
    if (key === "POST /anonymous/delete") return w.cookie(anonymous.token);
    if (key === "POST /anonymous/sign-in") return {};
    return takes(key, "session") ? w.cookie(ada.token) : {};
  };
  return { bodies, headersOf };
}

describe("the hook codes on every route that declares them (plan 11g)", () => {
  for (const [mode, code, status] of [
    ["refuse", "hook_refused", 403],
    ["throw", "hook_failed", 500],
  ] as const) {
    it(`answers ${status} ${code} on every route that declares it when a before hook ${mode}s`, async () => {
      const w = hookWorld(mode);
      const { bodies, headersOf } = await hookFlows(w);
      // The delete with no mailed confirm runs the hook at the request: a world with the confirm off.
      const direct = hookWorld(mode, { account: {} });
      const bob = await verifiedSession(direct.auth, "bob@example.com");
      const atOnce: RouteKey = "POST /user/delete";
      const routes = declaring(code).filter((key) => !HOOK_ROUTES_ELSEWHERE.includes(key));
      expect(routes.length).toBeGreaterThan(0);
      for (const key of routes)
        if (key !== atOnce) expect(bodies[key], `${key} has no flow in hookFlows`).toBeDefined();
      w.armed.on = true;
      direct.armed.on = true;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const results: Record<string, Answer> = {};
      for (const key of routes)
        results[key] =
          key === atOnce
            ? await call(direct, key, direct.cookie(bob.token), {})
            : await call(w, key, headersOf(key), bodies[key]);
      log.mockRestore();
      // The challenge form carries the code in a redirect to the page.
      expect(unlike(results, code, status, ["POST /totp/challenge"])).toEqual({});
    });
  }
});

/**
 * The routes that declare `token_expired` and that this file does not
 * drive. The provider callbacks need a provider exchange, and the passkey
 * second factor a registered passkey. social.test.ts and second-factor.test.ts
 * prove the engine path.
 */
const EXPIRY_ROUTES_ELSEWHERE: readonly RouteKey[] = [
  "GET /social/:provider/callback",
  "POST /social/apple/callback",
  "POST /second-factor/passkey/enable",
  // The mailed tokens of the account: their own tests in email-change.test.ts and account-delete.test.ts.
  "POST /user/change-email/confirm",
  "POST /user/delete/confirm",
  "POST /reauth",
  "POST /passkey/register/verify",
  "POST /passkey/authenticate/verify",
  // A pending domain past 7 days needs a platform operator with a fresh session after the
  // move of the clock: sso/domain-routes.test.ts drives it.
  "POST /sso/domains/verify",
];

describe("token_expired on every route that declares it (plan 11g)", () => {
  it("answers token_expired to each token, code, and challenge after its lifetime", async () => {
    const w = world();
    const { config } = w.auth;
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const dan = await verifiedSession(w.auth, "dan@example.com");
    const org = must(
      await createOrganization(config, { user: ada.user, slug: "acme", name: "Acme" }),
    );
    must(
      await inviteMember(config, {
        user: ada.user,
        organizationId: org.organization.id,
        email: emailOf(dan.user),
        role: "member",
      }),
    );
    const inviteToken = w.lastInvitation();
    must(await requestPasswordReset(config, { email: emailOf(ada.user), ip: null }));
    const resetToken = w.lastToken();
    must(await requestMagicLink(config, { email: emailOf(ada.user), ip: null }));
    const magicToken = w.lastToken();
    must(
      await passwordSignUp(config, {
        email: "pat@example.com",
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    );
    const verifyToken = w.lastToken();
    const { verifier, challenge } = await pkce();
    const start = must(
      await startHandoff(config, { challenge, redirect: "example://auth", ip: null }),
    );
    const second = must(
      await startHandoff(config, { challenge, redirect: "example://auth", ip: null }),
    );
    const landed = must(
      await continueHandoff(config, {
        handoffId: second.handoffId,
        userId: ada.user.id,
        sessionId: ada.session.id,
      }),
    );
    const handoffCode = new URL(landed.location).searchParams.get("code") ?? "";
    // Plan 12i Task 8: a sign-up challenge of 5 minutes.
    const signUp = await signUpCeremony(config);
    // Past every lifetime. The sessions of the probe are new ones.
    w.auth.clock.advance(31 * 86_400_000);
    const adaAgain = await createSession(config, {
      userId: ada.user.id,
      ip: null,
      userAgent: null,
    });
    const danAgain = await createSession(config, {
      userId: dan.user.id,
      ip: null,
      userAgent: null,
    });
    const bodies: { readonly [K in RouteKey]?: Record<string, unknown> } = {
      "POST /handoff/continue": { h: start.handoffId },
      "POST /handoff/redeem": { code: handoffCode, verifier },
      "POST /organizations/invitations/accept": { token: inviteToken },
      "POST /organizations/invitations/decline": { token: inviteToken },
      "POST /password/reset": { token: resetToken, password: "a new horse battery" },
      "POST /password/verify": { token: verifyToken },
      "POST /magic-link/verify": { token: magicToken },
      "POST /passkey/sign-up/verify": signUp,
    };
    const queries: { readonly [K in RouteKey]?: Record<string, string> } = {
      "GET /handoff/continue": { h: start.handoffId },
    };
    const routes = declaring("token_expired").filter(
      (key) => !EXPIRY_ROUTES_ELSEWHERE.includes(key),
    );
    expect(routes.length).toBeGreaterThan(0);
    const results: Record<string, Answer> = {};
    for (const key of routes) {
      const headers =
        key === "POST /organizations/invitations/accept"
          ? w.cookie(danAgain.token)
          : w.cookie(adaAgain.token);
      const query = queries[key];
      if (query) {
        const url = `${BASE_URL}/auth${entryOf(key).path}?${new URLSearchParams(query)}`;
        results[key] = await answerOf(await w.handle(new Request(url, { headers })));
      } else {
        expect(bodies[key], `${key} has no body here`).toBeDefined();
        results[key] = await call(w, key, headers, bodies[key]);
      }
    }
    // The handoff pages carry the code in a redirect to the app.
    const redirects: RouteKey[] = ["GET /handoff/continue", "POST /handoff/continue"];
    expect(unlike(results, "token_expired", 400, redirects)).toEqual({});
  });
});

/**
 * A world whose Google and Apple exchange runs on the fake token endpoint
 * and the fake jwt seam (as social.test.ts does). `tokens["idtok-default"]`
 * is the ID token of the next callback; with none, the token does not verify.
 */
function socialWorld(extra: Partial<AuthConfig> = {}) {
  const tokens: Record<string, FakeIdToken> = {};
  const w = world({
    social: { google: GOOGLE, apple: APPLE, fetch: tokenEndpoint("idtok-default").fetchFn },
    jwt: fakeJwt(tokens),
    ...extra,
  });
  return { ...w, tokens };
}
type SocialWorld = ReturnType<typeof socialWorld>;
type Provider = "google" | "apple";

/** The callback route of each provider of these tests: Google by GET, Apple by POST. */
const CALLBACK_OF: Record<Provider, RouteKey> = {
  google: "GET /social/:provider/callback",
  apple: "POST /social/apple/callback",
};

/** A start through the router: the sign-in start, or the link start of `session`. The binding cookie, the state, and the nonce. */
async function startOf(w: SocialWorld, provider: Provider, session?: Record<string, string>) {
  const res = session
    ? await w.handle(
        new Request(`${BASE_URL}/auth/social/${provider}/link`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL, ...session },
          body: "{}",
        }),
      )
    : await w.handle(new Request(`${BASE_URL}/auth/social/${provider}/start`));
  const location = session
    ? ((await res.json()) as { url?: string }).url
    : res.headers.get("location");
  if (!location) throw new Error(`the start answered ${res.status} with no location`);
  const bind = res.headers
    .getSetCookie()
    .find((c) => c.includes("_oauth="))
    ?.split(";")[0];
  if (!bind) throw new Error("the start set no binding cookie");
  const url = new URL(location);
  return {
    bind,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
  };
}
type Started = Awaited<ReturnType<typeof startOf>>;

/** The ID token of `provider` for the flow's nonce, with `claims` over the defaults. */
function idTokenOf(
  provider: Provider,
  nonce: string,
  claims: Record<string, unknown>,
): FakeIdToken {
  if (provider === "google") return googleClaims(nonce, claims);
  return {
    audience: APPLE.clientId,
    issuer: "https://appleid.apple.com",
    claims: { sub: "001.a", email: "ada@example.com", email_verified: true, nonce, ...claims },
  };
}

/** The callback through the router, from the browser that started: Google by GET, Apple by a form POST from Apple's origin. */
async function callbackOf(
  w: SocialWorld,
  provider: Provider,
  s: Started,
  options: { error?: string; session?: Record<string, string> } = {},
): Promise<Answer> {
  const cookie = [s.bind, options.session?.cookie].filter(Boolean).join("; ");
  const params = options.error
    ? { error: options.error, state: s.state }
    : { code: "c", state: s.state };
  if (provider === "google")
    return answerOf(
      await w.handle(
        new Request(`${BASE_URL}/auth/social/google/callback?${new URLSearchParams(params)}`, {
          headers: { cookie },
        }),
      ),
    );
  return answerOf(
    await w.handle(
      new Request(`${BASE_URL}/auth/social/apple/callback`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://appleid.apple.com",
          cookie,
        },
        body: new URLSearchParams(params).toString(),
      }),
    ),
  );
}

/** A sign-in callback of a new address with `claims`, in a world of `extra`. */
async function signInCallback(
  provider: Provider,
  claims: Record<string, unknown>,
  extra: Partial<AuthConfig> = {},
): Promise<Answer> {
  const w = socialWorld(extra);
  const s = await startOf(w, provider);
  w.tokens["idtok-default"] = idTokenOf(provider, s.nonce, claims);
  return callbackOf(w, provider, s);
}

/** A link callback of the signed-in `user` with `claims`. */
async function linkCallback(
  w: SocialWorld,
  provider: Provider,
  token: string,
  claims: Record<string, unknown>,
) {
  const session = w.cookie(token);
  const s = await startOf(w, provider, session);
  w.tokens["idtok-default"] = idTokenOf(provider, s.nonce, claims);
  return callbackOf(w, provider, s, { session });
}

/** A before hook that refuses, or throws. */
function hookOf(mode: "refuse" | "throw") {
  return () => {
    if (mode === "refuse") throw hookRefusal("Not now.");
    throw new Error("down");
  };
}

/** A passkey by the register ceremony, as a settings page adds one (as identities.test.ts does). */
async function addPasskey(w: World, user: UserRow) {
  const soft = await SoftAuthenticator.create({ rpID: "api.example.com", origin: BASE_URL });
  const options = must(await passkeyRegistrationOptions(w.auth.config, { user }));
  const added = must(
    await verifyPasskeyRegistration(w.auth.config, {
      user,
      response: await soft.register(options.challenge, new TextEncoder().encode(user.id)),
    }),
  );
  return { id: added.id, soft };
}

describe("the codes of the provider callbacks (plan 11g)", () => {
  for (const provider of ["google", "apple"] as const) {
    it(`${CALLBACK_OF[provider]} answers each code of completeSocial through the router`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const results: Record<string, Answer> = {};
      // The link of a signed-in user whose provider address differs.
      const mismatch = socialWorld();
      const ada = await verifiedSession(mismatch.auth, "ada@example.com");
      results.email_mismatch = await linkCallback(mismatch, provider, ada.token, {
        email: "other@example.com",
      });
      results.email_required = await signInCallback(provider, { email: undefined });
      // A verified user holds the address; the provider does not verify it.
      const taken = socialWorld();
      await verifiedSession(taken.auth, "ada@example.com");
      const s = await startOf(taken, provider);
      taken.tokens["idtok-default"] = idTokenOf(provider, s.nonce, {
        email: "ada@example.com",
        email_verified: false,
      });
      results.email_taken_unverified = await callbackOf(taken, provider, s);
      results.sign_up_closed = await signInCallback(
        provider,
        { email: "new@example.com" },
        { signUp: false },
      );
      // The state row lives ten minutes.
      const late = socialWorld();
      const stale = await startOf(late, provider);
      late.tokens["idtok-default"] = idTokenOf(provider, stale.nonce, {});
      late.auth.clock.advance(11 * 60_000);
      results.token_expired = await callbackOf(late, provider, stale);
      for (const [mode, code] of [
        ["refuse", "hook_refused"],
        ["throw", "hook_failed"],
      ] as const)
        results[code] = await signInCallback(
          provider,
          { email: "new@example.com" },
          { hooks: { user: { beforeCreate: hookOf(mode) } } },
        );
      if (provider === "apple") {
        // The provider identity of one user, linked by another.
        const held = socialWorld();
        const first = await startOf(held, "apple");
        held.tokens["idtok-default"] = idTokenOf("apple", first.nonce, {
          sub: "001.a",
          email: "first@example.com",
        });
        expect(await callbackOf(held, "apple", first)).toEqual({ status: 302, code: null });
        const bob = await verifiedSession(held.auth, "bob@example.com");
        results.identity_taken = await linkCallback(held, "apple", bob.token, { sub: "001.a" });
        const denied = socialWorld();
        results.oauth_denied = await callbackOf(denied, "apple", await startOf(denied, "apple"), {
          error: "access_denied",
        });
        // No ID token registered: the token does not verify.
        const failed = socialWorld();
        results.oauth_failed = await callbackOf(failed, "apple", await startOf(failed, "apple"));
      }
      log.mockRestore();
      const differing: Record<string, Answer> = {};
      for (const [code, got] of Object.entries(results))
        if (got.status !== 302 || got.code !== code) differing[code] = got;
      expect(differing).toEqual({});
      // Each code above is one the entry declares.
      for (const code of Object.keys(results))
        expect(entryOf(CALLBACK_OF[provider]).codes as readonly string[]).toContain(code);
    });
  }

  it("POST /social/:provider/link answers oauth_failed when the provider's discovery fails", async () => {
    const w = world({
      social: {
        oidc: [
          {
            name: "entra",
            label: "Continue with Microsoft",
            issuer: "https://login.acme.example/tenant-1/v2.0",
            clientId: "entra-id",
            clientSecret: "entra-secret",
          },
        ],
        fetch: async () => new Response("down", { status: 503 }),
      },
    });
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/social/entra/link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, ...w.cookie(ada.token) },
        body: "{}",
      }),
    );
    log.mockRestore();
    expect(await answerOf(res)).toEqual({ status: 400, code: "oauth_failed" });
  });
});

describe("the hook codes of a linked identity and a passkey sign-in (plan 11g)", () => {
  for (const [mode, code, status] of [
    ["refuse", "hook_refused", 403],
    ["throw", "hook_failed", 500],
  ] as const) {
    it(`POST /identities/unlink answers ${code} when identity.beforeUnlink ${mode}s`, async () => {
      const tokens: Record<string, FakeIdToken> = {};
      const w = world({
        social: { google: GOOGLE, apple: APPLE, fetch: tokenEndpoint("idtok-default").fetchFn },
        jwt: fakeJwt(tokens),
        hooks: { identity: { beforeUnlink: hookOf(mode) } },
      });
      const me = await googleSignIn(w.auth, tokens);
      const google = (
        await w.auth.storage.findMany("identity", [
          { field: "userId", op: "eq", value: me.user.id },
          { field: "provider", op: "eq", value: "google" },
        ])
      )[0];
      if (!google) throw new Error("no google identity");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const got = await call(w, "POST /identities/unlink", w.cookie(me.token), { id: google.id });
      log.mockRestore();
      expect(got).toEqual({ status, code });
    });

    it(`POST /passkey/authenticate/verify answers ${code} when session.beforeCreate ${mode}s`, async () => {
      const w = hookWorld(mode);
      const me = await verifiedSession(w.auth, "ada@example.com");
      const { soft } = await addPasskey(w, me.user);
      const res = await w.handle(requestOf("POST /passkey/authenticate/options", {}, {}));
      const { challenge } = (await res.json()) as { challenge: string };
      const response = await soft.authenticate(challenge);
      w.armed.on = true;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const got = await call(w, "POST /passkey/authenticate/verify", {}, { response });
      log.mockRestore();
      expect(got).toEqual({ status, code });
    });
  }

  it("POST /passkeys/delete answers second_factor_last_method for the one passkey of the passkey method", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const { id, soft } = await addPasskey(w, me.user);
    const options = must(await passkeyAuthenticationOptions(w.auth.config, { ip: null }));
    const cookie = w.cookie(me.token);
    expect(
      await call(w, "POST /second-factor/passkey/enable", cookie, {
        password: PASSWORD,
        response: await soft.authenticate(options.challenge),
      }),
    ).toEqual({ status: 200, code: null });
    expect(await call(w, "POST /passkeys/delete", cookie, { id })).toEqual({
      status: 409,
      code: "second_factor_last_method",
    });
  });

  it("the options routes answer a stored passkey with no transports without the key", async () => {
    // An authenticator may report no transports (getTransports is optional in WebAuthn).
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const cookie = w.cookie(me.token);
    const optionsOf = async (key: RouteKey, body: Record<string, unknown> = {}) => {
      const res = await w.handle(requestOf(key, cookie, {}, body));
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const soft = await SoftAuthenticator.create({ rpID: "api.example.com", origin: BASE_URL });
    const first = await optionsOf("POST /passkey/register/options");
    const registration = await soft.register(
      String(first.challenge),
      new TextEncoder().encode(me.user.id),
    );
    const { transports: _, ...response } = registration.response;
    expect(
      await call(w, "POST /passkey/register/verify", cookie, {
        response: { ...registration, response },
      }),
    ).toEqual({ status: 200, code: null });
    const descriptors = (answer: Record<string, unknown>, key: string) =>
      answer[key] as { id: string; transports?: string[] }[];
    const again = descriptors(
      await optionsOf("POST /passkey/register/options"),
      "excludeCredentials",
    );
    expect(again).toEqual([{ id: registration.id, type: "public-key" }]);
    const reauth = descriptors(await optionsOf("POST /reauth/passkey/options"), "allowCredentials");
    expect(reauth).toEqual([{ id: registration.id, type: "public-key" }]);
    // The passkey method on, then a password sign-in that answers the challenge of the second factor.
    const signIn = must(await passkeyAuthenticationOptions(w.auth.config, { ip: null }));
    expect(
      await call(w, "POST /second-factor/passkey/enable", cookie, {
        password: PASSWORD,
        response: await soft.authenticate(signIn.challenge),
      }),
    ).toEqual({ status: 200, code: null });
    const challenge = await challengeOf(w, "ada@example.com");
    const second = descriptors(
      await optionsOf("POST /second-factor/passkey/options", { challenge }),
      "allowCredentials",
    );
    expect(second).toEqual([{ id: registration.id, type: "public-key" }]);
  });
});

/**
 * The shapes of a JSON answer that the recorder holds to the wire (ruling
 * 8): an optional key left out, a nullable key set null. Each test reaches
 * the shape through the router, so the check sees it on that route.
 */
describe("the shapes of the OAuth answers (plan 11g)", () => {
  it("the userinfo routes answer no email without the email scope, and a null name under profile", async () => {
    const h = oauthHandle();
    const bare = await codeFor(h, "openid mcp:read");
    const bareTokens = (await (
      await h.auth.handle(exchange(bare.code, bare.clientId, bare.verifier))
    ).json()) as { access_token: string };
    const userinfo = async (token: string, method: "GET" | "POST") =>
      (
        await h.auth.handle(
          new Request(`${BASE_URL}/auth/oauth/userinfo`, {
            method,
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).json();
    for (const method of ["GET", "POST"] as const)
      expect(await userinfo(bareTokens.access_token, method)).toEqual({ sub: bare.user.id });
    // A user with no name and no picture, under the profile scope.
    const now = h.clock.now();
    const user = await h.storage.create("user", {
      id: newId(now),
      email: "nil@example.com",
      emailVerified: true,
      name: null,
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
    const { token } = await createSession(h.config, { userId: user.id, ip: null, userAgent: null });
    const clientId = await registered(h);
    const p = await pkce();
    const { code } = await authorized(h, `${h.config.cookieName}=${token}`, {
      clientId,
      challenge: p.challenge,
      scope: "openid profile mcp:read",
    });
    const profileTokens = (await (
      await h.auth.handle(exchange(code, clientId, p.verifier))
    ).json()) as {
      access_token: string;
    };
    for (const method of ["GET", "POST"] as const)
      expect(await userinfo(profileTokens.access_token, method)).toEqual({
        sub: user.id,
        name: null,
        picture: null,
      });
  });

  it("POST /oauth/register answers no client_name when the metadata names none, and the grant of that client a null clientName", async () => {
    const h = oauthHandle();
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.example.com/callback"] }),
      }),
    );
    expect(res.status).toBe(201);
    const client = (await res.json()) as { client_id: string; client_name?: string };
    expect("client_name" in client).toBe(false);
    const s = await signedIn(h);
    const p = await pkce();
    await authorized(h, s.cookie, {
      clientId: client.client_id,
      challenge: p.challenge,
      scope: "openid mcp:read",
    });
    const grants = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/grants`, { headers: { cookie: s.cookie } }),
    );
    expect(await grants.json()).toMatchObject({
      grants: [{ clientId: client.client_id, clientName: null }],
    });
  });
});

describe("the shapes of the account answers (plan 11g)", () => {
  it("GET /passkeys answers a null name for a passkey registered with none", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    await addPasskey(w, me.user);
    const res = await w.handle(requestOf("GET /passkeys", w.cookie(me.token), {}));
    expect(await res.json()).toMatchObject({ passkeys: [{ name: null }] });
  });

  it("GET /tokens/current answers a null expiresAt for a token that never expires", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const made = await w.handle(
      requestOf("POST /tokens", w.cookie(me.token), {}, { name: "forever", expiresInDays: null }),
    );
    const { token } = (await made.json()) as { token: string };
    const res = await w.handle(
      requestOf("GET /tokens/current", { authorization: `Bearer ${token}` }, {}),
    );
    expect(await res.json()).toMatchObject({ apiToken: { expiresAt: null } });
  });

  it("POST /user/update answers a null name when the patch clears it", async () => {
    const w = world();
    const me = await verifiedSession(w.auth, "ada@example.com");
    const res = await w.handle(
      requestOf("POST /user/update", w.cookie(me.token), {}, { name: null }),
    );
    expect(await res.json()).toMatchObject({ user: { name: null } });
  });
});
