import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DELETE_TOKEN_RE } from "../src/engine/account-delete.js";
import { EMAIL_CHANGE_TOKEN_RE } from "../src/engine/email-change.js";
import { CHALLENGE_RE, ID_RE, startHandoff } from "../src/engine/handoff.js";
import { MAGIC_LINK_TOKEN_RE } from "../src/engine/magic-link.js";
import { CHALLENGE_RE as PKCE_CHALLENGE_RE } from "../src/engine/oauth-authorize.js";
import { createClient } from "../src/engine/oauth-client-store.js";
import { DEVICE_GRANT } from "../src/engine/oauth-clients.js";
import {
  PASSWORD_RESET_TOKEN_RE,
  PASSWORD_VERIFY_TOKEN_RE,
  passwordSignIn,
} from "../src/engine/password.js";
import { TWO_FACTOR_TOKEN_RE } from "../src/engine/second-factor.js";
import { createSession } from "../src/engine/sessions.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { AUTH_ERROR_PARAM } from "../src/http/redirect.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRouteModules, coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { everyFeature, SOCIAL } from "./every-feature.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, tokenFromMail } from "./helpers.js";
import { basicHeader, pkce, requestIdOf } from "./oauth-helpers.js";
import { FAST } from "./password-helpers.js";
import { codeNow, enrolled, PASSWORD, verifiedSession } from "./totp-helpers.js";

/** The contract table, read as a plain record. */
const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;

/** 43 characters of a token body, as every `xx_` token of core has. */
const BODY43 = "A".repeat(43);
/** 42 characters: one short of a token body, so a token regex refuses it. */
const SHORT = "A".repeat(42);
/** The redirect URI of the test OAuth client, and the one resource of `everyFeature`. */
const REDIRECT = "https://client.example.com/callback";
const RESOURCE = `${BASE_URL}/mcp`;
/** The operator secret whose hash the world's config holds. */
const OPERATOR_SECRET = "operator-secret-0123456789abcdef-0123456789";
/** The header of that secret. */
const OPERATOR = { authorization: `Operator ${OPERATOR_SECRET}` };

/** What a route answered: the status, and the code of a JSON error or of a redirect's error parameter. */
interface Answer {
  status: number;
  code: string | null;
}

/** A redirect carries `auth_error` to the app, or `error` to an OAuth client. */
async function answerOf(res: Response): Promise<Answer> {
  if (res.status === 302 || res.status === 303) {
    const location = new URL(res.headers.get("location") ?? "");
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

/** The keys that the generator writes as `required` for an object schema. */
function requiredOf(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input" }) as { required?: string[] };
  return json.required ?? [];
}

/** The `pattern` that the generator writes for one key of an object schema, or null. */
function patternOf(schema: z.ZodType, key: string): string | null {
  const json = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, { pattern?: string }>;
  };
  return json.properties?.[key]?.pattern ?? null;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** A form post from the app's origin. A value that is not a string is sent as its JSON text. */
function postForm(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body))
    params.set(key, typeof value === "string" ? value : JSON.stringify(value));
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      ...headers,
    },
    body: params.toString(),
  });
}

/**
 * A world with every feature on, a password hash that runs fast, and the
 * mailed delete confirm. `secretHash` is the operator's; the default admits no secret.
 */
function world(secretHash = "0".repeat(64)) {
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    passkey: {
      rpID: "api.example.com",
      rpName: "Example",
      origins: [BASE_URL],
      signUp: { isolateLimiter: "allow" },
    },
    handoff: { schemes: ["example://"] },
    social: SOCIAL,
    // The platform role turns on the impersonation routes (plan 12f).
    organizations: {
      platformRole: "owner",
      platformOrganization: "platform-co",
      dynamicRoles: {},
      teams: {},
    },
    oauth: { resources: [RESOURCE], registration: { cimd: false, dynamic: true }, device: {} },
    // One secret with every scope, the user tools, and the impersonation of plan 12f.
    operator: {
      secrets: [
        { name: "default", secretHash, scopes: ["keys", "secrets", "users", "sessions", "audit"] },
      ],
      users: true,
      impersonation: {},
    },
    account: { deleteConfirm: { ttlMinutes: 60 } },
    // The domain routes and the SAML ACS of plan 12d; no test of this file asks the resolver.
    sso: { saml: true, dns: [{ name: "none", txt: async () => [] }] },
    // The SCIM token routes of plan 12d Task 9b.
    scim: {},
    // The username routes of plan 12i Task 2.
    username: {},
    // The phone routes of plan 12i Task 5, on the memory limiter.
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" },
    // The anonymous routes of plan 12i Task 6.
    anonymous: { isolateLimiter: "allow" },
    // The multi-session routes of plan 12i Task 11.
    multiSession: {},
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookieOf = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, handle, cookieOf };
}
type World = ReturnType<typeof world>;

/** A fresh challenge of the user with the factor on, from a real password sign-in. */
async function challengeOf(auth: World["auth"], email: string): Promise<string> {
  const r = await passwordSignIn(auth.config, {
    email,
    password: PASSWORD,
    ip: "2.2.2.2",
    userAgent: "Agent/2",
  });
  if (!r.ok || !("twoFactor" in r.value)) throw new Error("the sign-in answered no challenge");
  return r.value.twoFactor.challenge;
}

/** The token of the last mail that the fake mail port recorded. */
function lastToken(auth: World["auth"]): string {
  const last = auth.mail.at(-1);
  if (!last) throw new Error("no mail");
  return tokenFromMail(last.text);
}

/** The newest mailed token with `prefix`, such as `ec_` of an address change. */
function lastTokenWith(auth: World["auth"], prefix: string): string {
  for (const m of [...auth.mail].reverse()) {
    const token = /token=([A-Za-z0-9_%-]+)/.exec(m.text)?.[1];
    if (token?.startsWith(prefix)) return decodeURIComponent(token);
  }
  throw new Error(`no ${prefix} token in a mail`);
}

/** The 6-digit code of the last mail. */
function lastCode(auth: World["auth"]): string {
  const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1];
  if (!code) throw new Error("no code in mail");
  return code;
}

/** The invitation token of the last mail. */
function lastInvitation(auth: World["auth"]): string {
  const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(auth.mail.at(-1)?.text ?? "");
  if (!m?.[1]) throw new Error("no invitation in mail");
  return m[1];
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`${what} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** An organization of the session's user, made through the route. */
async function organizationOf(w: World, cookie: Record<string, string>, slug: string) {
  const body = await jsonOf<{ organization: { id: string } }>(
    await w.handle(post("/auth/organizations/create", { slug, name: slug }, cookie)),
    "the create",
  );
  return body.organization.id;
}

/** A registered OAuth client, through the route. */
async function registeredClient(w: World): Promise<string> {
  const body = await jsonOf<{ client_id: string }>(
    await w.handle(
      post("/auth/oauth/register", { redirect_uris: [REDIRECT], client_name: "Test client" }),
    ),
    "the register",
  );
  return body.client_id;
}

/** A valid authorize query of the client, with `scope`. `prompt: "consent"` shows the consent page again. */
function authorizeQuery(clientId: string, challenge: string, scope = "openid", prompt?: string) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    resource: RESOURCE,
    state: "st-1",
    ...(prompt === undefined ? {} : { prompt }),
  };
}

/**
 * An authorization code of the session's user for `clientId`: the authorize
 * GET, and the consent form when the page shows. The PKCE verifier comes with it.
 */
async function codeOf(w: World, cookie: Record<string, string>, clientId: string, scope?: string) {
  const p = await pkce();
  const page = await w.handle(
    get(`/auth/oauth/authorize?${query(authorizeQuery(clientId, p.challenge, scope))}`, cookie),
  );
  let location = page.headers.get("location");
  if (page.status === 200) {
    const done = await w.handle(
      postForm(
        "/auth/oauth/authorize",
        { request_id: requestIdOf(await page.text()), decision: "allow" },
        { ...cookie, origin: BASE_URL },
      ),
    );
    location = done.headers.get("location");
  }
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (!code) throw new Error(`the authorize answered ${page.status} with no code`);
  return { code, verifier: p.verifier };
}

const tokenForm = (clientId: string, code: string, verifier: string) => ({
  grant_type: "authorization_code",
  code,
  code_verifier: verifier,
  client_id: clientId,
  redirect_uri: REDIRECT,
  resource: RESOURCE,
});

const INVALID_BODY: Answer = { status: 400, code: "invalid_body" };
const INVALID_TOKEN: Answer = { status: 400, code: "invalid_token" };
const PAGE_REFUSED: Answer = { status: 302, code: "invalid_token" };

/** One POST whose body the route parses with its schema (test 4), and the credential it needs. */
interface BodyRow {
  key: RouteKey;
  /** A function reads a mailed token at the row's turn, after the row that mails it. */
  body: Record<string, unknown> | (() => Record<string, unknown>);
  path?: string;
  session?: true;
  headers?: Record<string, string>;
  /** Absent for a schema with no required key: it refuses no body of the form `{ __x: 1 }`. */
  refused?: Answer;
}

/**
 * The bodies of every POST that parses with its schema. Each body is one that
 * the schema accepts, with the session it needs and the answer of a refused body.
 * The order matters. The account delete goes last, since it ends the
 * session's user, and the password change goes before it.
 */
async function validBodies(w: World): Promise<{ rows: BodyRow[]; cookie: Record<string, string> }> {
  const me = await verifiedSession(w.auth);
  const cookie = w.cookieOf(me.token);
  const { secret } = await enrolled(w.auth, "totp@example.com");
  const challenge = await challengeOf(w.auth, "totp@example.com");
  const { challenge: pkceChallenge } = await pkce();
  const started = await startHandoff(w.auth.config, {
    challenge: pkceChallenge,
    redirect: "example://auth",
    ip: "1.1.1.1",
  });
  if (!started.ok) throw new Error(started.code);
  // The real tokens of the mailed links, so each verify route takes its valid body.
  await w.handle(post("/auth/magic-link/request", { email: "link@example.com" }));
  const magicToken = lastToken(w.auth);
  await w.handle(post("/auth/password/sign-up", { email: "new@example.com", password: PASSWORD }));
  const verifyToken = lastToken(w.auth);
  await w.handle(post("/auth/password/reset/request", { email: "new@example.com" }));
  const resetToken = lastToken(w.auth);
  // A pending address change and a pending delete, so each confirm row has a mailed token.
  await jsonOf(
    await w.handle(post("/auth/user/change-email", { newEmail: "ada.new@example.com" }, cookie)),
    "the address change",
  );
  await jsonOf(await w.handle(post("/auth/user/delete", {}, cookie)), "the delete request");
  const org = await organizationOf(w, cookie, "setup");
  const bob = await w.auth.seedUser("bob@example.com");
  const id = "x".repeat(26);
  const rows: BodyRow[] = [
    { key: "POST /sessions/revoke", body: { id }, session: true, refused: INVALID_BODY },
    // The operator secret of the world: the route checks it before the body (plan 11c2).
    {
      key: "POST /operator/secrets/rewrap",
      body: { limit: 10 },
      headers: { authorization: `Operator ${OPERATOR_SECRET}` },
      refused: INVALID_BODY,
    },
    // The operator tools of plan 12f: the actor first, then the body. A user id that names no
    // user answers not_found, so these rows change no row that a later row reads.
    ...(
      [
        [
          "POST /operator/users/ban",
          { userId: id, reason: "case 1", until: "2026-02-01T00:00:00Z" },
        ],
        ["POST /operator/users/unban", { userId: id, reason: "case 1" }],
        ["POST /operator/users/platform-role", { userId: id, grant: true, reason: "case 1" }],
        [
          "POST /operator/users/second-factor/disable",
          {
            userId: id,
            reason: "case 1",
            proof: { method: "document", reference: "c-1", checkedAt: "2025-12-31T23:00:00Z" },
          },
        ],
        ["POST /operator/users/create-admin", { email: "admin@example.com", reason: "case 1" }],
        ["POST /operator/sessions/end-user", { userId: id, reason: "case 1" }],
      ] as const
    ).map(([key, body]) => ({ key, body, headers: OPERATOR, refused: INVALID_BODY })),
    // The session is no platform operator: the start answers operator_required after the body.
    {
      key: "POST /operator/impersonate",
      body: { userId: id, reason: "Ticket 1" },
      session: true,
      refused: INVALID_BODY,
    },
    // The session is no impersonation: the stop answers not_found after the body.
    {
      key: "POST /operator/impersonate/stop",
      body: { reason: "Done" },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /reauth", body: { password: PASSWORD }, session: true, refused: INVALID_BODY },
    {
      key: "POST /user/update",
      body: { name: "Ada", image: null },
      session: true,
      refused: INVALID_BODY,
    },
    // Plan 12i Task 2: the set of a username.
    { key: "POST /user/username", body: { username: "Ada" }, session: true, refused: INVALID_BODY },
    // Plan 12i Task 11: an id of no session of the browser answers not_found.
    {
      key: "POST /multi-session/switch",
      body: { sessionId: id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /multi-session/sign-out",
      body: { sessionId: id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /user/change-email",
      body: { newEmail: "ada.other@example.com", method: "link", next: "/inbox" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /user/change-email/confirm",
      body: () => ({ token: lastTokenWith(w.auth, "ec_") }),
      refused: INVALID_TOKEN,
    },
    {
      key: "POST /user/change-email/verify",
      body: { code: "000000" },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /identities/unlink", body: { id }, session: true, refused: INVALID_BODY },
    {
      key: "POST /magic-link/request",
      body: { email: "ada@example.com", next: "/inbox" },
      refused: INVALID_BODY,
    },
    { key: "POST /magic-link/verify", body: { token: magicToken }, refused: INVALID_TOKEN },
    {
      key: "POST /social/:provider/link",
      path: "/social/google/link",
      body: { next: "/inbox" },
      session: true,
    },
    { key: "POST /social/apple/callback", body: { code: "c", state: "s" } },
    // Plan 12i Task 10: the ID-token route. The valid sign-in body has no live nonce: invalid_token.
    {
      key: "POST /social/:provider/id-token/nonce",
      path: "/social/google/id-token/nonce",
      body: {},
      refused: INVALID_BODY,
    },
    {
      key: "POST /social/:provider/id-token",
      path: "/social/apple/id-token",
      body: { idToken: "a.b.c", nonce: "A".repeat(43) },
      refused: INVALID_BODY,
    },
    // Plan 12i Task 9: the hints of one ceremony. The body is optional and strict.
    {
      key: "POST /passkey/register/options",
      body: { hints: ["security-key"] },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /passkey/authenticate/options",
      body: { hints: ["hybrid"] },
      refused: INVALID_BODY,
    },
    {
      key: "POST /passkey/register/verify",
      body: { response: { id: "cred", response: { clientDataJSON: "data" } }, name: "Key" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /passkey/authenticate/verify",
      body: { response: { id: "cred", response: { clientDataJSON: "data" } } },
      refused: INVALID_BODY,
    },
    // Plan 12i Task 8: the passkey-first sign-up. The body is strict.
    {
      key: "POST /passkey/sign-up/options",
      body: { name: "Ana", hints: ["client-device"] },
      refused: INVALID_BODY,
    },
    {
      key: "POST /passkey/sign-up/verify",
      body: { response: { id: "cred", response: { clientDataJSON: "data" } } },
      refused: INVALID_BODY,
    },
    { key: "POST /passkeys/delete", body: { id }, session: true, refused: INVALID_BODY },
    {
      key: "POST /passkeys/rename",
      body: { id, name: "Key" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /password/sign-up",
      body: { email: "bob2@example.com", password: PASSWORD, name: "Bob" },
      refused: INVALID_BODY,
    },
    {
      key: "POST /password/sign-in",
      body: { email: "ada@example.com", password: PASSWORD, next: "/inbox" },
      refused: INVALID_BODY,
    },
    { key: "POST /password/verify", body: { token: verifyToken }, refused: INVALID_TOKEN },
    // Plan 12i Task 20: the sign-up code. No code row: the engine answers invalid_code.
    {
      key: "POST /password/verify/code",
      body: { email: "bob2@example.com", code: "000000" },
      refused: INVALID_BODY,
    },
    {
      key: "POST /password/verify/resend",
      body: { email: "bob2@example.com" },
      refused: INVALID_BODY,
    },
    {
      key: "POST /password/reset/request",
      body: { email: "ada@example.com", next: "/inbox" },
      refused: INVALID_BODY,
    },
    {
      key: "POST /password/reset",
      body: { token: resetToken, password: "another horse battery" },
      refused: INVALID_TOKEN,
    },
    { key: "POST /totp/setup", body: { password: PASSWORD }, session: true, refused: INVALID_BODY },
    { key: "POST /totp/enable", body: { code: "000000" }, session: true, refused: INVALID_BODY },
    { key: "POST /totp/disable", body: { code: "000000" }, session: true, refused: INVALID_BODY },
    {
      key: "POST /totp/backup-codes",
      body: { code: "000000" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /totp/verify",
      body: { challenge: `tf_${BODY43}`, code: "000000", trustDevice: true },
      refused: INVALID_BODY,
    },
    {
      key: "POST /totp/challenge",
      body: { challenge, code: await codeNow(w.auth, secret), trustDevice: "1" },
      refused: PAGE_REFUSED,
    },
    {
      key: "POST /second-factor/passkey/enable",
      body: { password: PASSWORD, response: { id: "cred", response: { clientDataJSON: "data" } } },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /second-factor/passkey/options",
      body: { challenge: `tf_${BODY43}` },
      refused: INVALID_BODY,
    },
    {
      key: "POST /second-factor/email/enable",
      body: { password: PASSWORD },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /second-factor/email/send",
      body: { challenge: `tf_${BODY43}` },
      refused: INVALID_BODY,
    },
    {
      key: "POST /second-factor/disable",
      body: { method: "email", password: PASSWORD },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /otp/request", body: { email: "ada@example.com" }, refused: INVALID_BODY },
    {
      key: "POST /otp/verify",
      body: { email: "ada@example.com", code: "000000" },
      refused: INVALID_BODY,
    },
    { key: "POST /otp/reset/request", body: { email: "ada@example.com" }, refused: INVALID_BODY },
    // Plan 12i Task 5: the phone routes.
    { key: "POST /phone/request", body: { phone: "+14155550100" }, refused: INVALID_BODY },
    {
      key: "POST /phone/verify",
      body: { phone: "+14155550100", code: "000000" },
      refused: INVALID_BODY,
    },
    {
      key: "POST /phone/add",
      body: { phone: "+14155550101" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /phone/add/verify",
      body: { code: "000000" },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /phone/remove", body: {}, session: true, refused: INVALID_BODY },
    // Plan 12i Task 6: the anonymous routes. The session of the world is no
    // anonymous session, so the valid delete body answers anonymous_refused.
    { key: "POST /anonymous/sign-in", body: {}, refused: INVALID_BODY },
    { key: "POST /anonymous/delete", body: {}, session: true, refused: INVALID_BODY },
    {
      key: "POST /otp/reset",
      body: { email: "ada@example.com", code: "000000", password: "another horse battery" },
      refused: INVALID_BODY,
    },
    {
      key: "POST /handoff/continue",
      body: { h: started.value.handoffId },
      session: true,
      headers: { origin: BASE_URL },
      refused: PAGE_REFUSED,
    },
    {
      key: "POST /handoff/redeem",
      body: { code: "x".repeat(26), verifier: "v".repeat(43) },
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/create",
      body: { slug: "acme", name: "Acme", metadata: { plan: "free" } },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/update",
      body: { organizationId: org, name: "Setup Co", slug: "setup-co", metadata: null },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/members/add",
      body: { organizationId: org, userId: bob.id, role: "member" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/members/role",
      body: { organizationId: org, userId: bob.id, role: "admin" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/members/remove",
      body: { organizationId: org, userId: bob.id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/invite",
      body: { organizationId: org, email: "carol@example.com", role: "member" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/invitations/revoke",
      body: { organizationId: org, invitationId: id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/invitations/accept",
      body: { token: `inv_${BODY43}` },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/invitations/decline",
      body: { token: `inv_${BODY43}` },
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/active",
      body: { organizationId: org },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/has-permission",
      body: { organizationId: org, permissions: { member: ["read"] } },
      session: true,
      refused: INVALID_BODY,
    },
    // The three role writes in order: the update and the delete find the created role.
    {
      key: "POST /organizations/roles/create",
      body: { organizationId: org, name: "editor", permissions: { member: ["read"] } },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/roles/update",
      body: { organizationId: org, name: "editor", rank: 1 },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/roles/delete",
      body: { organizationId: org, name: "editor" },
      session: true,
      refused: INVALID_BODY,
    },
    // The team rows name an id that no team holds: the engine answers not_found, past the parse.
    {
      key: "POST /organizations/teams/create",
      body: { organizationId: org, name: "Core" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/teams/update",
      body: { teamId: id, name: "Web" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/teams/delete",
      body: { teamId: id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/teams/members/add",
      body: { teamId: id, userId: id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/teams/members/remove",
      body: { teamId: id, userId: id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/teams/active",
      body: { teamId: null },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/check-slug",
      body: { slug: "beta" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/tokens",
      body: { organizationId: org, name: "ci", permissions: {} },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/tokens/update",
      body: { organizationId: org, id },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /organizations/tokens/revoke",
      body: { organizationId: org, id },
      session: true,
      refused: INVALID_BODY,
    },
    // The domain rows of plan 12d. A user who is no platform operator gets
    // forbidden_rank, and an id that names no domain gets not_found, past the parse.
    {
      key: "POST /sso/domains/add",
      body: { organizationId: org, domain: "acme.example" },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /sso/domains/verify", body: { id }, session: true, refused: INVALID_BODY },
    {
      key: "POST /sso/domains/update",
      body: { id, enforce: false },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /sso/domains/delete", body: { id }, session: true, refused: INVALID_BODY },
    // The connection rows of plan 12d Task 3: forbidden_rank for the create, and not_found
    // for an id that names no connection, past the parse.
    {
      key: "POST /sso/connections/create",
      body: {
        organizationId: org,
        kind: "oidc",
        label: "Acme",
        issuer: "https://login.idp.example",
        clientId: "acme",
        clientSecret: "acme-secret",
      },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /sso/connections/update",
      body: { id, label: "Acme" },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /sso/connections/delete", body: { id }, session: true, refused: INVALID_BODY },
    // The SCIM token rows of plan 12d Task 9b: forbidden_rank for the create, and not_found for
    // an id that names no token, past the parse.
    {
      key: "POST /scim/tokens/create",
      body: { organizationId: org, name: "Entra ID" },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /scim/tokens/revoke", body: { id }, session: true, refused: INVALID_BODY },
    // The discovery of plan 12d Task 4: an address with no SSO answers { sso: false }.
    { key: "POST /sso/discover", body: { email: "ada@example.com" }, refused: INVALID_BODY },
    {
      key: "POST /organizations/delete",
      body: { organizationId: org },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /tokens",
      body: { name: "ci", expiresInDays: 30, organizationId: null },
      session: true,
      refused: INVALID_BODY,
    },
    { key: "POST /tokens/revoke", body: { id }, session: true, refused: INVALID_BODY },
    { key: "POST /tokens/update", body: { id }, session: true, refused: INVALID_BODY },
    {
      key: "POST /oauth/grants/revoke",
      body: { clientId: "cl_none" },
      session: true,
      refused: INVALID_BODY,
    },
    {
      key: "POST /password/change",
      body: { currentPassword: PASSWORD, newPassword: "another horse battery" },
      session: true,
      refused: INVALID_BODY,
    },
    // The account delete: the mailed link went out above, and the session's user ends here.
    { key: "POST /user/delete", body: {}, session: true, refused: INVALID_BODY },
    {
      key: "POST /user/delete/confirm",
      body: () => ({ token: lastTokenWith(w.auth, "ad_") }),
      session: true,
      refused: INVALID_TOKEN,
    },
    // The secret has no scope sso: the engine answers operator_required, past the parse.
    {
      key: "POST /operator/sso/enforce-off",
      body: { domainId: id, reason: "case 2" },
      headers: OPERATOR,
      refused: INVALID_BODY,
    },
    // The end of all sessions goes last: it ends the session of every row above.
    {
      key: "POST /operator/sessions/end-all",
      body: { reason: "case 1", limit: 10 },
      headers: OPERATOR,
      refused: INVALID_BODY,
    },
  ];
  return { rows, cookie };
}

/** The bytes of a route's JSON answer, held to its contract schema: the parse succeeds and changes nothing. */
async function checkAnswer(key: RouteKey, res: Response, status = 200): Promise<unknown> {
  const answer = CONTRACT[key]?.answer;
  if (answer?.kind !== "json") throw new Error(`${key} answers no JSON`);
  const text = await res.text();
  expect(res.status, `${key}: ${text}`).toBe(status);
  expect(answer.status ?? 200, `${key}: the status of the contract`).toBe(status);
  const body: unknown = JSON.parse(text);
  const result = answer.schema.safeParse(body);
  expect(result.success, `${key}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
  expect(result.data, `${key}: the parse changed the answer`).toEqual(body);
  return body;
}

describe("the route contract (plan 11g)", () => {
  it("gives every route of ROUTES one contract, and no contract without a route", () => {
    const keys = Object.keys(ROUTE_CONTRACT).sort();
    expect(keys).toEqual(ROUTES.map((r) => `${r.method} ${r.path}`).sort());
    // Plan 12k Task 8 adds the five organization token routes.
    // Plan 12h Task 8 adds GET /health and GET /ready, so 144 became 146.
    // Plan 12d Task 2b adds the five domain routes and the operator's override.
    // Plan 12d Task 3 adds the four connection routes.
    // Plan 12d Task 4 adds the discovery, the start, and the callback.
    // Plan 12d Task 9b adds the three SCIM token routes and ten routes of /scim/v2.
    // Plan 12d Task 8 adds the SAML ACS and the SP metadata.
    // Plan 12d Task 10 adds the six routes of the SCIM Users.
    // Plan 12d Task 11 adds the six routes of the SCIM Groups.
    // Plan 12i Task 9 adds GET /.well-known/webauthn.
    // Plan 12i Task 2 adds GET /username/available and POST /user/username.
    // Plan 12i Task 5 adds the five phone routes, and Task 6 the two anonymous routes.
    // Plan 12i Task 11 adds the three multi-session routes.
    // Plan 12i Task 10 adds the two routes of the ID-token sign-in.
    // Plan 12i Task 20 adds POST /password/verify/code.
    // Plan 12i Task 8 adds the two routes of the passkey-first sign-up.
    expect(keys.length).toBe(204);
    // Every mounted route of every module has a key with a contract, and every contract is mounted.
    const mounted = new Set<string>();
    const modules = coreRouteModules(everyFeature());
    for (const m of modules)
      for (const route of m.routes) {
        expect(route.key, `${m.module} ${route.method} ${route.path} has no key`).toBeDefined();
        if (!route.key) continue;
        expect(CONTRACT[route.key], `${route.key} has no contract`).toBeDefined();
        mounted.add(route.key);
      }
    // Plan 12h Task 8 adds the module of http/health.ts, so 20 became 21.
    // Plan 12d Task 2b adds the module sso, so 21 became 22, and Task 9b the
    // module scim, so 22 became 23. Plan 12i Task 2 adds the module
    // username, so 23 became 24. Plan 12i Task 5 adds the module phone: 25.
    // Plan 12i Task 6 adds the module anonymous: 26. Plan 12i Task 11 adds
    // the module multi-session: 27.
    expect(modules.length).toBe(27);
    expect([...mounted].sort()).toEqual(keys);
  });

  it("holds a hand-read query to its schema", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const cookie = w.cookieOf(me.token);
    await enrolled(w.auth, "totp@example.com");
    const challenge = await challengeOf(w.auth, "totp@example.com");
    const { challenge: pkceChallenge } = await pkce();
    const started = await startHandoff(w.auth.config, {
      challenge: pkceChallenge,
      redirect: "example://auth",
      ip: "1.1.1.1",
    });
    if (!started.ok) throw new Error(started.code);
    const org = await organizationOf(w, cookie, "acme");
    // A stored role, so the valid query of the role get finds a row.
    await jsonOf(
      await w.handle(
        post(
          "/auth/organizations/roles/create",
          { organizationId: org, name: "editor", permissions: { member: ["read"] } },
          cookie,
        ),
      ),
      "the role create",
    );
    // A team, so the valid query of the team members finds a row.
    const { team } = await jsonOf<{ team: { id: string } }>(
      await w.handle(
        post("/auth/organizations/teams/create", { organizationId: org, name: "Core" }, cookie),
      ),
      "the team create",
    );
    const clientId = await registeredClient(w);
    const INVALID_REQUEST: Answer = { status: 400, code: "invalid_request" };
    const BACK_INVALID: Answer = { status: 302, code: "invalid_request" };
    /**
     * Each GET that reads its query by hand: a valid query, and the keys the schema requires
     * with the answer of each one's absence. `valid` is the answer of the valid query. `wrong`
     * is for a GET whose schema holds a key to the engine's regex. It names the key, a value of
     * a wrong form, the answer of the route, and the engine's regex.
     */
    const VALID_QUERIES: {
      key: RouteKey;
      path: string;
      query: Record<string, string>;
      headers?: Record<string, string>;
      required: readonly string[];
      valid: Answer;
      missing: Record<string, Answer>;
      wrong?: { key: string; value: string; answer: Answer; regex: RegExp };
    }[] = [
      {
        key: "GET /user/change-email/confirm",
        path: "/user/change-email/confirm",
        query: { token: `ec_${BODY43}` },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: PAGE_REFUSED },
        wrong: {
          key: "token",
          value: `ec_${SHORT}`,
          answer: PAGE_REFUSED,
          regex: EMAIL_CHANGE_TOKEN_RE,
        },
      },
      {
        key: "GET /user/delete/confirm",
        path: "/user/delete/confirm",
        query: { token: `ad_${BODY43}` },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: PAGE_REFUSED },
        wrong: { key: "token", value: `ad_${SHORT}`, answer: PAGE_REFUSED, regex: DELETE_TOKEN_RE },
      },
      {
        key: "GET /magic-link/verify",
        path: "/magic-link/verify",
        query: { token: `ml_${BODY43}` },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: PAGE_REFUSED },
        wrong: {
          key: "token",
          value: `ml_${SHORT}`,
          answer: PAGE_REFUSED,
          regex: MAGIC_LINK_TOKEN_RE,
        },
      },
      {
        key: "GET /social/:provider/start",
        path: "/social/google/start",
        query: { next: "/inbox" },
        required: [],
        valid: { status: 302, code: null },
        missing: {},
      },
      {
        key: "GET /social/:provider/callback",
        path: "/social/google/callback",
        query: { code: "c", state: "s", error: "" },
        required: [],
        valid: PAGE_REFUSED,
        missing: {},
      },
      // Plan 12d Task 4: an id that names no connection, and a state of no start.
      {
        key: "GET /sso/:connectionId/start",
        path: "/sso/c-none/start",
        query: { next: "/inbox" },
        required: [],
        valid: { status: 302, code: "sso_not_configured" },
        missing: {},
      },
      {
        key: "GET /sso/:connectionId/callback",
        path: "/sso/c-none/callback",
        query: { code: "c", state: "s", error: "" },
        required: [],
        valid: { status: 302, code: "sso_failed" },
        missing: {},
      },
      {
        key: "GET /password/verify",
        path: "/password/verify",
        query: { token: `pv_${BODY43}` },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: PAGE_REFUSED },
        wrong: {
          key: "token",
          value: `pv_${SHORT}`,
          answer: PAGE_REFUSED,
          regex: PASSWORD_VERIFY_TOKEN_RE,
        },
      },
      {
        key: "GET /password/reset",
        path: "/password/reset",
        query: { token: `pr_${BODY43}`, error: "password_policy" },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: PAGE_REFUSED },
        wrong: {
          key: "token",
          value: `pr_${SHORT}`,
          answer: PAGE_REFUSED,
          regex: PASSWORD_RESET_TOKEN_RE,
        },
      },
      {
        key: "GET /totp/challenge",
        path: "/totp/challenge",
        query: { challenge, method: "totp", backup: "1", error: "invalid_code" },
        required: ["challenge"],
        valid: { status: 200, code: null },
        missing: { challenge: PAGE_REFUSED },
        wrong: {
          key: "challenge",
          value: `tf_${SHORT}`,
          answer: PAGE_REFUSED,
          regex: TWO_FACTOR_TOKEN_RE,
        },
      },
      {
        key: "GET /handoff/start",
        path: "/handoff/start",
        query: { challenge: pkceChallenge, redirect: "example://auth" },
        required: ["challenge", "redirect"],
        valid: { status: 200, code: null },
        missing: { challenge: INVALID_BODY, redirect: INVALID_BODY },
        wrong: { key: "challenge", value: SHORT, answer: INVALID_BODY, regex: CHALLENGE_RE },
      },
      {
        key: "GET /handoff/continue",
        path: "/handoff/continue",
        query: { h: started.value.handoffId },
        required: ["h"],
        valid: { status: 200, code: null },
        missing: { h: PAGE_REFUSED },
        wrong: { key: "h", value: "abc", answer: PAGE_REFUSED, regex: ID_RE },
      },
      {
        key: "GET /organizations/members",
        path: "/organizations/members",
        query: { organizationId: org },
        headers: cookie,
        required: ["organizationId"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY },
      },
      {
        key: "GET /organizations/permissions",
        path: "/organizations/permissions",
        query: { organizationId: org },
        headers: cookie,
        required: ["organizationId"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY },
      },
      {
        key: "GET /organizations/roles",
        path: "/organizations/roles",
        query: { organizationId: org },
        headers: cookie,
        required: ["organizationId"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY },
      },
      {
        key: "GET /organizations/roles/get",
        path: "/organizations/roles/get",
        query: { organizationId: org, name: "editor" },
        headers: cookie,
        required: ["organizationId", "name"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY, name: INVALID_BODY },
      },
      {
        key: "GET /organizations/tokens",
        path: "/organizations/tokens",
        query: { organizationId: org },
        headers: cookie,
        required: ["organizationId"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY },
      },
      {
        key: "GET /organizations/invitations",
        path: "/organizations/invitations",
        query: { organizationId: org },
        headers: cookie,
        required: ["organizationId"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY },
      },
      {
        key: "GET /organizations/teams",
        path: "/organizations/teams",
        query: { organizationId: org },
        headers: cookie,
        required: ["organizationId"],
        valid: { status: 200, code: null },
        missing: { organizationId: INVALID_BODY },
      },
      {
        key: "GET /organizations/teams/members",
        path: "/organizations/teams/members",
        query: { teamId: team.id },
        headers: cookie,
        required: ["teamId"],
        valid: { status: 200, code: null },
        missing: { teamId: INVALID_BODY },
      },
      {
        // With no session: the sign-in step, a redirect with no error. The first two keys are
        // refused as JSON; the others go back to the client with the error.
        key: "GET /oauth/authorize",
        path: "/oauth/authorize",
        query: authorizeQuery(clientId, pkceChallenge),
        // PKCE is optional in the schema: a confidential client may omit it with openid and a
        // nonce (plan 12e). oauth-client-auth.test.ts holds the refusal for every other request.
        // resource is optional too: oauth.defaultResource may stand in for it (ruling 52).
        // oauth-default-resource.test.ts holds invalid_target without the key.
        required: ["response_type", "client_id", "redirect_uri", "scope"],
        valid: { status: 302, code: null },
        missing: {
          response_type: { status: 302, code: "unsupported_response_type" },
          client_id: INVALID_REQUEST,
          redirect_uri: INVALID_REQUEST,
          scope: { status: 302, code: "invalid_scope" },
        },
        wrong: {
          key: "code_challenge",
          value: SHORT,
          answer: BACK_INVALID,
          regex: PKCE_CHALLENGE_RE,
        },
      },
      {
        // The code form; a value of another form leaves the field empty (plan 12e).
        key: "GET /oauth/device",
        path: "/oauth/device",
        query: { user_code: "BCDF-GHJK" },
        headers: cookie,
        required: [],
        valid: { status: 200, code: null },
        missing: {},
      },
      {
        key: "GET /oauth/sign-in",
        path: "/oauth/sign-in",
        query: { next: `/auth/oauth/authorize?client_id=${clientId}` },
        required: ["next"],
        valid: { status: 200, code: null },
        missing: { next: { status: 302, code: "invalid_request" } },
      },
      {
        // OIDC RP-Initiated Logout 1.0 section 2: every parameter is optional. With no session,
        // and no valid hint, the signed-out page answers.
        key: "GET /oauth/end-session",
        path: "/oauth/end-session",
        query: { client_id: clientId, state: "st-1", ui_locales: "en", logout_hint: "ada" },
        required: [],
        valid: { status: 200, code: null },
        missing: {},
      },
    ];
    const hand = Object.entries(CONTRACT)
      .filter(([, c]) => c.query?.parsedBy === "hand")
      .map(([key]) => key)
      .sort();
    expect(hand).toEqual(VALID_QUERIES.map((row) => row.key).sort());
    expect(hand.length).toBe(24);
    let wrongForms = 0;
    for (const row of VALID_QUERIES) {
      const contract = CONTRACT[row.key];
      const schema = contract?.query?.schema;
      if (!schema) throw new Error(`${row.key} has no query schema`);
      expect(contract.body, `${row.key} has a body`).toBeUndefined();
      expect(schema.safeParse(row.query).success, `${row.key}: the valid query`).toBe(true);
      expect(requiredOf(schema), row.key).toEqual(row.required);
      const res = await w.handle(get(`/auth${row.path}?${query(row.query)}`, row.headers));
      expect(await answerOf(res), `${row.key}: the valid query`).toEqual(row.valid);
      for (const key of row.required) {
        const { [key]: _dropped, ...without } = row.query;
        expect(schema.safeParse(without).success, `${row.key} without ${key}`).toBe(false);
        const refused = await w.handle(get(`/auth${row.path}?${query(without)}`, row.headers));
        expect(await answerOf(refused), `${row.key} without ${key}`).toEqual(row.missing[key]);
      }
      if (!row.wrong) continue;
      wrongForms += 1;
      // The document's pattern is the engine's regex itself, so a copy of it fails here.
      expect(patternOf(schema, row.wrong.key), `${row.key}: the pattern`).toBe(
        row.wrong.regex.source,
      );
      const wrong = { ...row.query, [row.wrong.key]: row.wrong.value };
      expect(schema.safeParse(wrong).success, `${row.key}: the wrong form`).toBe(false);
      const refused = await w.handle(get(`/auth${row.path}?${query(wrong)}`, row.headers));
      expect(await answerOf(refused), `${row.key}: the wrong form`).toEqual(row.wrong.answer);
    }
    // The nine GETs whose schema holds a key to an engine regex.
    expect(wrongForms).toBe(9);
  });

  it("holds a hand-read body to its schema", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const cookie = w.cookieOf(me.token);
    const clientId = await registeredClient(w);
    const INVALID_REQUEST: Answer = { status: 400, code: "invalid_request" };
    /** A consent form of a fresh held request: the page shows again with `prompt=consent`. */
    const consentForm = async (): Promise<Record<string, unknown>> => {
      const p = await pkce();
      const page = await w.handle(
        get(
          `/auth/oauth/authorize?${query(authorizeQuery(clientId, p.challenge, "openid", "consent"))}`,
          cookie,
        ),
      );
      return { request_id: requestIdOf(await page.text()), decision: "allow" };
    };
    const consent = { ...cookie, origin: BASE_URL };
    // A code of a second request, for the token exchange.
    const { code, verifier } = await codeOf(w, cookie, clientId);
    // A resource server that may introspect (plan 12e).
    const rs = await createClient(w.auth.config, {
      authMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      introspect: true,
    });
    if (!rs.ok || !rs.value.clientSecret) throw new Error("no resource server");
    const rsBasic = { authorization: basicHeader(rs.value.client.id, rs.value.clientSecret) };
    // A public client of the device grant (plan 12e).
    const deviceClient = await jsonOf<{ client_id: string }>(
      await w.handle(
        post("/auth/oauth/register", {
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code", DEVICE_GRANT],
        }),
      ),
      "the device client register",
    );
    /**
     * Each POST that reads its body by hand, with its media and a valid body. It also has the
     * keys that the schema requires, with the answer when each one is absent. `valid` is the
     * answer of the valid body.
     * The valid body runs first, so a spent code shapes the later answers of the token route.
     * `fresh` makes a new valid body for each probe, where the valid body spends a request.
     */
    const VALID_FORMS: {
      key: RouteKey;
      /** The path of a route with a parameter: its key holds the template. */
      path?: string;
      media: "json" | "form";
      body: Record<string, unknown>;
      fresh?: () => Promise<Record<string, unknown>>;
      headers?: Record<string, string>;
      required: readonly string[];
      valid: Answer;
      missing: Record<string, Answer>;
    }[] = [
      {
        key: "POST /oauth/register",
        media: "json",
        body: { redirect_uris: [REDIRECT], client_name: "Second client" },
        required: ["redirect_uris"],
        valid: { status: 201, code: null },
        missing: { redirect_uris: { status: 400, code: "invalid_redirect_uri" } },
      },
      {
        // The consent route differs: a form with no decision is a deny, so the answer is a
        // redirect, not a 400. Each probe takes a fresh held request, since a post spends one.
        key: "POST /oauth/authorize",
        media: "form",
        body: await consentForm(),
        fresh: consentForm,
        headers: consent,
        required: ["request_id", "decision"],
        valid: { status: 302, code: null },
        missing: {
          request_id: INVALID_REQUEST,
          decision: { status: 302, code: "access_denied" },
        },
      },
      {
        key: "POST /oauth/token",
        media: "form",
        body: tokenForm(clientId, code, verifier),
        // A client_secret_basic client names itself in the header (plan 12e).
        required: ["grant_type"],
        valid: { status: 200, code: null },
        missing: {
          grant_type: { status: 400, code: "unsupported_grant_type" },
        },
      },
      {
        // RFC 7009 section 2.2: a revoke answers 200 for an unknown token, also for none.
        key: "POST /oauth/revoke",
        media: "form",
        body: { token: `or_${BODY43}`, client_id: clientId },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: { status: 200, code: null } },
      },
      {
        // RFC 8628 section 3.1: every key is optional in the schema; the engine refuses a missing scope.
        key: "POST /oauth/device_authorization",
        media: "form",
        body: { client_id: deviceClient.client_id, scope: "openid", resource: RESOURCE },
        required: [],
        valid: { status: 200, code: null },
        missing: {},
      },
      {
        // An unknown code shows the form again with its error: the page answers 200.
        key: "POST /oauth/device",
        media: "form",
        body: { user_code: "BCDF-GHJK" },
        headers: consent,
        required: ["user_code"],
        valid: { status: 200, code: null },
        missing: { user_code: { status: 200, code: null } },
      },
      {
        // RFC 7662 section 2.1: an unknown token answers active false; the token is required.
        key: "POST /oauth/introspect",
        media: "form",
        body: { token: `or_${BODY43}` },
        headers: rsBasic,
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { token: { status: 400, code: "invalid_request" } },
      },
      {
        // The SAML ACS (plan 12d Task 8): a form of no start answers the step request, and a
        // form without a key the step form. Each failure of the ACS is a redirect with sso_failed.
        key: "POST /sso/:connectionId/acs",
        // An id that names no connection, in the id form (the events of plan 12h reject another form).
        path: "/sso/c-none/acs",
        media: "form",
        body: { SAMLResponse: "PHNhbWxwOlJlc3BvbnNlLz4=", RelayState: `rs_${BODY43}` },
        required: ["SAMLResponse", "RelayState"],
        valid: { status: 302, code: "sso_failed" },
        missing: {
          SAMLResponse: { status: 302, code: "sso_failed" },
          RelayState: { status: 302, code: "sso_failed" },
        },
      },
      {
        // OIDC RP-Initiated Logout 1.0 section 2: the POST form of the same optional parameters.
        // With no session it goes on as a GET of the same request (ruling 46 of plan 12e).
        key: "POST /oauth/end-session",
        media: "form",
        body: { client_id: clientId, state: "st-1" },
        required: [],
        valid: { status: 303, code: null },
        missing: {},
      },
    ];
    const hand = Object.entries(CONTRACT)
      .filter(([, c]) => c.body?.parsedBy === "hand")
      .map(([key]) => key)
      .sort();
    expect(hand).toEqual(VALID_FORMS.map((row) => row.key).sort());
    // Plan 12d Task 8 adds the SAML ACS.
    expect(hand.length).toBe(9);
    for (const row of VALID_FORMS) {
      const contract = CONTRACT[row.key];
      const body = contract?.body;
      if (!body) throw new Error(`${row.key} has no body schema`);
      expect(body.media, row.key).toEqual([row.media]);
      expect(contract.query, `${row.key} has a query`).toBeUndefined();
      expect(body.schema.safeParse(row.body).success, `${row.key}: the valid body`).toBe(true);
      expect(requiredOf(body.schema), row.key).toEqual(row.required);
      const path = `/auth${row.path ?? row.key.slice("POST ".length)}`;
      const send = (b: Record<string, unknown>) =>
        w.handle(
          row.media === "json" ? post(path, b, row.headers) : postForm(path, b, row.headers),
        );
      expect(await answerOf(await send(row.body)), `${row.key}: the valid body`).toEqual(row.valid);
      for (const key of row.required) {
        const { [key]: _dropped, ...without } = row.fresh ? await row.fresh() : row.body;
        expect(body.schema.safeParse(without).success, `${row.key} without ${key}`).toBe(false);
        expect(await answerOf(await send(without)), `${row.key} without ${key}`).toEqual(
          row.missing[key],
        );
      }
    }
  });

  it("uses the contract's schema in the route", async () => {
    const w = world(await sha256Hex(OPERATOR_SECRET));
    const { rows, cookie } = await validBodies(w);
    const withBody = Object.entries(CONTRACT)
      .filter(([, c]) => c.body?.parsedBy === "zod")
      .map(([key]) => key)
      .sort();
    expect(withBody).toEqual(rows.map((row) => row.key).sort());
    // Plan 12d Task 2b adds five: four domain writes and the override.
    // Plan 12d Task 3 adds the three connection writes. Task 4 adds the discovery.
    // Plan 12d Task 9b adds the two SCIM token writes.
    // Plan 12i Task 9 adds the bodies of the two passkey options routes.
    // Plan 12i Task 2 adds the body of POST /user/username.
    // Plan 12i Task 5 adds the bodies of the five phone routes, and Task 6 the two anonymous bodies.
    // Plan 12i Task 11 adds the bodies of the multi-session switch and sign-out.
    // Plan 12i Task 10 adds the bodies of the ID-token nonce and sign-in.
    // Plan 12i Task 20 adds the body of the sign-up code.
    // Plan 12i Task 8 adds the two bodies of the passkey-first sign-up.
    expect(withBody.length).toBe(108);
    let refusals = 0;
    for (const row of rows) {
      const contract = CONTRACT[row.key];
      const schema = contract?.body?.schema;
      if (!schema) throw new Error(`${row.key} has no body schema`);
      const path = row.path ?? row.key.slice("POST ".length);
      const headers = { ...(row.session ? cookie : {}), ...row.headers };
      // Each required key absent, and one key that no schema names.
      const refused = { __x: 1 };
      expect(schema.safeParse(refused).success, `${row.key}: the refused body`).toBe(
        row.refused === undefined,
      );
      if (row.refused) {
        refusals += 1;
        const res = await w.handle(post(`/auth${path}`, refused, headers));
        expect(await answerOf(res), `${row.key}: the refused body`).toEqual(row.refused);
      }
      const body = typeof row.body === "function" ? row.body() : row.body;
      expect(schema.safeParse(body).success, `${row.key}: the valid body`).toBe(true);
      const res = await w.handle(post(`/auth${path}`, body, headers));
      const answer = await answerOf(res);
      expect(answer.status, `${row.key}: the valid body answered ${answer.code}`).toBeLessThan(500);
      if (row.refused) expect(answer, `${row.key}: the valid body`).not.toEqual(row.refused);
    }
    // The two social bodies have no required key, so no body of this form is refused.
    // The two strict bodies of the ID-token route refuse it (plan 12i Task 10).
    // Plan 12i Task 20 adds the refusal of the sign-up code body.
    // Plan 12i Task 8 adds the two bodies of the passkey-first sign-up: 106.
    expect(refusals).toBe(106);
  });

  it("names the media of a body by its read call", async () => {
    const w = world(await sha256Hex(OPERATOR_SECRET));
    const { rows, cookie } = await validBodies(w);
    const media = (key: RouteKey) => CONTRACT[key]?.body?.media;
    // Every body names one of the four forms: readJson, readBody, a form read by hand, or JSON read by hand.
    const counts = { json: 0, both: 0, form: 0 };
    for (const [key, c] of Object.entries(CONTRACT)) {
      if (!c.body) continue;
      const m = [...c.body.media].join("+");
      if (m === "json") counts.json += 1;
      else if (m === "json+form") counts.both += 1;
      else if (m === "form") counts.form += 1;
      else throw new Error(`${key} names the media ${m}`);
      if (c.body.parsedBy === "hand") expect(m, key).not.toBe("json+form");
    }
    // Plan 12d Task 4: the discovery reads JSON and a form. Task 9b: the two SCIM token writes.
    // Task 8: the SAML ACS reads a form.
    // Plan 12i Task 9 adds the two passkey options bodies to json.
    // Plan 12i Task 2 adds the body of POST /user/username to json.
    // Plan 12i Task 5 adds the five phone bodies to json, and Task 6 the two anonymous bodies.
    // Plan 12i Task 11 adds the two multi-session bodies to json.
    // Plan 12i Task 10 adds the two ID-token bodies to json.
    // Plan 12i Task 20 adds the body of the sign-up code to json.
    // Plan 12i Task 8 adds the two bodies of the passkey-first sign-up to json.
    expect(counts).toEqual({ json: 99, both: 10, form: 8 });
    // The valid body as a form: a `json` route refuses it, and a route that reads a form does not.
    for (const row of rows) {
      const path = row.path ?? row.key.slice("POST ".length);
      const headers = { ...(row.session ? cookie : {}), ...row.headers };
      const body = typeof row.body === "function" ? row.body() : row.body;
      const res = await w.handle(postForm(`/auth${path}`, body, headers));
      const answer = await answerOf(res);
      if (media(row.key)?.includes("form"))
        expect(answer, `${row.key}: a form`).not.toEqual(INVALID_BODY);
      else expect(answer, `${row.key}: a form`).toEqual(INVALID_BODY);
    }
    // The seven hand-read forms refuse a JSON body, and the hand-read JSON refuses a form.
    // The consent route checks its origin and the session before the body.
    const consent = { ...cookie, origin: BASE_URL };
    for (const key of [
      "POST /oauth/authorize",
      "POST /oauth/token",
      "POST /oauth/revoke",
      "POST /oauth/introspect",
      "POST /oauth/device_authorization",
      "POST /oauth/device",
      "POST /oauth/end-session",
    ] as const)
      expect(
        await answerOf(await w.handle(post(`/auth${key.slice(5)}`, {}, consent))),
        key,
      ).toEqual({ status: 400, code: "invalid_request" });
    expect(media("POST /oauth/register")).toEqual(["json"]);
    expect(
      await answerOf(await w.handle(postForm("/auth/oauth/register", { redirect_uris: REDIRECT }))),
    ).toEqual({ status: 400, code: "invalid_client_metadata" });
  });

  it("describes each answer as the wire JSON", async () => {
    const w = world(await sha256Hex(OPERATOR_SECRET));
    const me = await verifiedSession(w.auth);
    const cookie = w.cookieOf(me.token);
    const check = async (key: RouteKey, req: Request, status = 200) =>
      checkAnswer(key, await w.handle(req), status);
    // The session answers: the read carries `needsRefresh` only with `session.deferRefresh` on.
    const session = (await check("GET /session", get("/auth/session", cookie))) as {
      session: { expiresAt: string };
    };
    expect(new Date(session.session.expiresAt).toISOString()).toBe(session.session.expiresAt);
    await check("POST /session/refresh", post("/auth/session/refresh", {}, cookie));
    await check("GET /sessions", get("/auth/sessions", cookie));
    await check("POST /sessions/revoke-others", post("/auth/sessions/revoke-others", {}, cookie));
    // The re-authentication, the profile, and the address.
    await check("POST /reauth", post("/auth/reauth", { password: PASSWORD }, cookie));
    await check("POST /reauth/email", post("/auth/reauth/email", {}, cookie));
    await check("POST /user/update", post("/auth/user/update", { name: "Ada" }, cookie));
    // Plan 12i Task 2: the username routes.
    await check("POST /user/username", post("/auth/user/username", { username: "Ada" }, cookie));
    await check("GET /username/available", get("/auth/username/available?username=ada"));
    // Plan 12i Task 11: the multi-session routes. A switch to the active session changes nothing.
    await check("GET /multi-session", get("/auth/multi-session", cookie));
    await check(
      "POST /multi-session/switch",
      post("/auth/multi-session/switch", { sessionId: me.session.id }, cookie),
    );
    const other = await verifiedSession(w.auth, "mia@example.com");
    await check(
      "POST /multi-session/sign-out",
      post(
        "/auth/multi-session/sign-out",
        { sessionId: other.session.id },
        w.cookieOf(other.token),
      ),
    );
    await check(
      "POST /user/change-email",
      post("/auth/user/change-email", { newEmail: "ada.new@example.com" }, cookie),
    );
    await check(
      "POST /user/change-email/confirm",
      post("/auth/user/change-email/confirm", { token: lastToken(w.auth) }),
    );
    await check(
      "POST /user/change-email",
      post("/auth/user/change-email", { newEmail: "ada.code@example.com", method: "code" }, cookie),
    );
    await check(
      "POST /user/change-email/verify",
      post("/auth/user/change-email/verify", { code: lastCode(w.auth) }, cookie),
    );
    await check("GET /identities", get("/auth/identities", cookie));
    // The second factor by an email code: the enable, a challenge's code, and the disable.
    await check(
      "POST /second-factor/email/enable",
      post("/auth/second-factor/email/enable", { password: PASSWORD }, cookie),
    );
    const challenge = await challengeOf(w.auth, "ada.code@example.com");
    await check(
      "POST /second-factor/email/send",
      post("/auth/second-factor/email/send", { challenge }),
    );
    await check(
      "POST /second-factor/disable",
      post("/auth/second-factor/disable", { method: "email", password: PASSWORD }, cookie),
    );
    await check("GET /totp", get("/auth/totp", cookie));
    await check("GET /passkeys", get("/auth/passkeys", cookie));
    await check(
      "POST /passkey/register/options",
      post("/auth/passkey/register/options", {}, cookie),
    );
    await check(
      "POST /passkey/authenticate/options",
      post("/auth/passkey/authenticate/options", {}),
    );
    // The organizations: the owner's answers, then the invitee's accept and a decline.
    const created = (await check(
      "POST /organizations/create",
      post("/auth/organizations/create", { slug: "acme", name: "Acme" }, cookie),
    )) as { organization: { id: string } };
    const org = created.organization.id;
    const byOrg = (path: string) => get(`/auth${path}?organizationId=${org}`, cookie);
    await check("GET /organizations", get("/auth/organizations", cookie));
    await check(
      "POST /organizations/update",
      post("/auth/organizations/update", { organizationId: org, name: "Acme Co" }, cookie),
    );
    const bob = await w.auth.seedUser("bob@example.com");
    await check(
      "POST /organizations/members/add",
      post(
        "/auth/organizations/members/add",
        { organizationId: org, userId: bob.id, role: "member" },
        cookie,
      ),
    );
    await check(
      "POST /organizations/members/role",
      post(
        "/auth/organizations/members/role",
        { organizationId: org, userId: bob.id, role: "admin" },
        cookie,
      ),
    );
    await check("GET /organizations/members", byOrg("/organizations/members"));
    await check(
      "POST /organizations/members/remove",
      post("/auth/organizations/members/remove", { organizationId: org, userId: bob.id }, cookie),
    );
    const invite = (email: string) =>
      post("/auth/organizations/invite", { organizationId: org, email, role: "member" }, cookie);
    const invited = (await check("POST /organizations/invite", invite("carol@example.com"))) as {
      invitation: { id: string };
    };
    await check("GET /organizations/invitations", byOrg("/organizations/invitations"));
    await check(
      "POST /organizations/invitations/revoke",
      post(
        "/auth/organizations/invitations/revoke",
        { organizationId: org, invitationId: invited.invitation.id },
        cookie,
      ),
    );
    await check("POST /organizations/invite", invite("carol@example.com"));
    const carol = await w.auth.seedUser("carol@example.com");
    const carolSession = await createSession(w.auth.config, {
      userId: carol.id,
      ip: null,
      userAgent: null,
    });
    await check(
      "POST /organizations/invitations/accept",
      post(
        "/auth/organizations/invitations/accept",
        { token: lastInvitation(w.auth) },
        w.cookieOf(carolSession.token),
      ),
    );
    await check("POST /organizations/invite", invite("dave@example.com"));
    await check(
      "POST /organizations/invitations/decline",
      post("/auth/organizations/invitations/decline", { token: lastInvitation(w.auth) }),
    );
    await check(
      "POST /organizations/active",
      post("/auth/organizations/active", { organizationId: org }, cookie),
    );
    // The organization tokens (plan 12k Task 8).
    const orgToken = (await check(
      "POST /organizations/tokens",
      post(
        "/auth/organizations/tokens",
        { organizationId: org, name: "ci", permissions: { member: ["read"] } },
        cookie,
      ),
    )) as { token: string; apiToken: { id: string } };
    await check("GET /organizations/tokens", byOrg("/organizations/tokens"));
    await check(
      "GET /organizations/tokens/current",
      get("/auth/organizations/tokens/current", { authorization: `Bearer ${orgToken.token}` }),
    );
    await check(
      "POST /organizations/tokens/update",
      post(
        "/auth/organizations/tokens/update",
        { organizationId: org, id: orgToken.apiToken.id, name: "cd" },
        cookie,
      ),
    );
    await check(
      "POST /organizations/tokens/revoke",
      post(
        "/auth/organizations/tokens/revoke",
        { organizationId: org, id: orgToken.apiToken.id },
        cookie,
      ),
    );
    await check(
      "POST /organizations/delete",
      post("/auth/organizations/delete", { organizationId: org }, cookie),
    );
    // The API tokens and the JWT.
    const minted = (await check(
      "POST /tokens",
      post("/auth/tokens", { name: "ci", expiresInDays: 30 }, cookie),
    )) as { token: string; apiToken: { id: string } };
    await check("GET /tokens", get("/auth/tokens", cookie));
    await check(
      "GET /tokens/current",
      get("/auth/tokens/current", { authorization: `Bearer ${minted.token}` }),
    );
    await check(
      "POST /tokens/update",
      post("/auth/tokens/update", { id: minted.apiToken.id, name: "cd" }, cookie),
    );
    await check(
      "POST /tokens/revoke",
      post("/auth/tokens/revoke", { id: minted.apiToken.id }, cookie),
    );
    const jwt = (await check("GET /token", get("/auth/token", cookie))) as { token: string };
    await check(
      "POST /token/live",
      post("/auth/token/live", {}, { authorization: `Bearer ${jwt.token}` }),
    );
    // The operator's rotation.
    await check(
      "POST /operator/keys/rotate",
      post(
        "/auth/operator/keys/rotate",
        {},
        { authorization: `Operator ${OPERATOR_SECRET}`, "cf-connecting-ip": "203.0.113.7" },
      ),
    );
    // The OAuth provider: a registration, a consent, the exchange, the userinfo, the grants, and the revokes.
    const client = (await check(
      "POST /oauth/register",
      post("/auth/oauth/register", { redirect_uris: [REDIRECT], client_name: "Test client" }),
      201,
    )) as { client_id: string };
    const { code, verifier } = await codeOf(w, cookie, client.client_id, "openid email profile");
    const tokens = (await check(
      "POST /oauth/token",
      postForm("/auth/oauth/token", tokenForm(client.client_id, code, verifier)),
    )) as { access_token: string };
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    await check("GET /oauth/userinfo", get("/auth/oauth/userinfo", bearer));
    await check("POST /oauth/userinfo", post("/auth/oauth/userinfo", {}, bearer));
    await check("GET /oauth/grants", get("/auth/oauth/grants", cookie));
    await check(
      "POST /oauth/revoke",
      postForm("/auth/oauth/revoke", { token: `or_${BODY43}`, client_id: client.client_id }),
    );
    await check(
      "POST /oauth/grants/revoke",
      post("/auth/oauth/grants/revoke", { clientId: client.client_id }, cookie),
    );
    // The end of the session's user: the sign-out, then the mailed delete and its confirm.
    await check("POST /sign-out", post("/auth/sign-out", {}, cookie));
    const again = await verifiedSession(w.auth, "ada.code@example.com");
    const cookie2 = w.cookieOf(again.token);
    await check("POST /user/delete", post("/auth/user/delete", {}, cookie2));
    await check(
      "POST /user/delete/confirm",
      post("/auth/user/delete/confirm", { token: lastToken(w.auth) }, cookie2),
    );
  });
});
