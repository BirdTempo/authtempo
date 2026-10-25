import type { Auth, UserRow } from "@authtempo/core";
import { APIError, apiError, BETTER_AUTH_CODES, messageOf, NOT_SUPPORTED } from "../errors.js";
import type { Session, User } from "../types.js";
import { translate } from "./email-otp.js";
import { sha256Hex } from "./mail.js";
import type { Mapped } from "./map-options.js";
import { readToken, toSession, toUser } from "./shapes.js";
import { withTwoFactor } from "./two-factor.js";

/**
 * Better Auth 1.7.2's paths of its sign-in plugins (plan 12i Task 16):
 * anonymous, username, phone-number, one-tap, multi-session, and the ID
 * token form of `/sign-in/social`. Each source was read 2026-10-25 in
 * dist/plugins/<id>/. Each path posts core's own route, so core's router
 * keeps its Origin rule, its limits, its gate, and its cookies. The shim
 * keeps only Better Auth's shapes, and refuses a field that core would drop.
 */
const ANONYMOUS_SIGN_IN = "/sign-in/anonymous";
const ANONYMOUS_DELETE = "/delete-anonymous-user";
const USERNAME_SIGN_IN = "/sign-in/username";
const USERNAME_AVAILABLE = "/is-username-available";
const PHONE_SEND = "/phone-number/send-otp";
const PHONE_VERIFY = "/phone-number/verify";
const PHONE_SIGN_IN = "/sign-in/phone-number";
/** Better Auth's reset by phone. Core has none, so each answers NOT_SUPPORTED. */
export const PHONE_NOT_SUPPORTED: readonly string[] = [
  "/phone-number/request-password-reset",
  "/phone-number/reset-password",
];
const ONE_TAP = "/one-tap/callback";
const SOCIAL_SIGN_IN = "/sign-in/social";
const DEVICE_SESSIONS = "/multi-session/list-device-sessions";
const SET_ACTIVE = "/multi-session/set-active";
const REVOKE_DEVICE = "/multi-session/revoke";

/** The providers of core's ID-token route (plan 12i Task 10). */
const ID_TOKEN_PROVIDERS: ReadonlySet<string> = new Set(["google", "apple"]);
/**
 * Better Auth stores these with the account for its `getAccessToken`.
 * Core keeps no provider token and serves no `/get-access-token` (README),
 * so no later call could read them: dropping them changes no answer.
 */
const UNKEPT_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "accessToken",
  "refreshToken",
  "expiresAt",
]);

type Body = Record<string, unknown>;

function failure(code: string, status: number, message = messageOf(code)): Response {
  return Response.json({ code, message }, { status });
}

async function readBody(request: Request): Promise<Body | null> {
  const v: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : null;
}

/** The keys of `body` outside `allowed`, for a NOT_SUPPORTED answer. */
function extraKeys(body: Body, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((k) => body[k] !== undefined && !allowed.includes(k));
}

/** The plugin of each path. A path of a plugin that is off is not served here. */
function pluginOfPath(path: string): string | null {
  if (path === ANONYMOUS_SIGN_IN || path === ANONYMOUS_DELETE) return "anonymous";
  if (path === USERNAME_SIGN_IN || path === USERNAME_AVAILABLE) return "username";
  if (
    path === PHONE_SEND ||
    path === PHONE_VERIFY ||
    path === PHONE_SIGN_IN ||
    PHONE_NOT_SUPPORTED.includes(path)
  )
    return "phone-number";
  if (path === ONE_TAP) return "one-tap";
  if (path === DEVICE_SESSIONS || path === SET_ACTIVE || path === REVOKE_DEVICE)
    return "multi-session";
  return null;
}

/**
 * The answer to one of these paths, or null for any other request, which
 * the handler passes to core. `request` is the handler's request after the
 * expo-origin rule and the Origin rules.
 */
export async function signInAdditionsRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${mapped.basePath}/`)) return null;
  const path = pathname.slice(mapped.basePath.length);
  const plugin = pluginOfPath(path);
  const social = path === SOCIAL_SIGN_IN && request.method === "POST";
  if (plugin === null && !social) return null;
  if (plugin !== null && !mapped.plugins.has(plugin)) return null;
  const get = path === DEVICE_SESSIONS;
  if (request.method !== (get ? "GET" : "POST")) return null;
  const core = async (method: "GET" | "POST", to: string, payload?: Body) => {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    if (payload) headers.set("content-type", "application/json");
    else headers.delete("content-type");
    const inner = new Request(`${mapped.origin}${mapped.basePath}${to}`, {
      method,
      headers,
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { inner, res: await auth.handle(inner, mapped.handleOptions) };
  };
  const userOf = async (id: unknown): Promise<User> => {
    const row =
      typeof id === "string"
        ? await mapped.config.storage.findOne("user", [{ field: "id", op: "eq", value: id }])
        : null;
    if (!row) throw new Error("authtempo compat: the signed-in user is gone");
    return toUser(row);
  };
  /** Better Auth's `{ token, user }` of a core sign-in answer. */
  const signedIn = async (b: Body) => ({
    token: b.token,
    user: await userOf((b.user as { id?: unknown } | undefined)?.id),
  });
  if (social) {
    const body = await readBody(request);
    // Without idToken, Better Auth's redirect sign-in: core serves its own start route.
    if (!body || body.idToken === undefined) return null;
    return idTokenSignIn(body, core, signedIn);
  }
  if (PHONE_NOT_SUPPORTED.includes(path))
    return failure(NOT_SUPPORTED, 501, "core has no password reset by phone; see the plan index");
  if (path === DEVICE_SESSIONS) return deviceSessions(mapped, core);
  const body = await readBody(request);
  if (!body) return failure(BETTER_AUTH_CODES.invalid_body, 400);
  switch (path) {
    case ANONYMOUS_SIGN_IN: {
      // Better Auth refuses a second anonymous sign-in (anonymous/index.mjs:96).
      // Core answers the live anonymous session again, so the shim refuses first.
      const s = await auth.session(request, { refresh: false });
      if (s?.user.isAnonymous)
        return failure("ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY", 400);
      return translate((await core("POST", "/anonymous/sign-in", {})).res, signedIn);
    }
    case ANONYMOUS_DELETE: {
      const res = await translate((await core("POST", "/anonymous/delete", {})).res, () => ({
        success: true,
      }));
      // Core names a session that is not anonymous ANONYMOUS_REFUSED. At this
      // path Better Auth 1.7.2 names it USER_IS_NOT_ANONYMOUS, 403
      // (anonymous/index.mjs:140, read 2026-10-25), so the shim does too.
      const body = (await res.clone().json()) as { code?: unknown };
      if (res.status === 403 && body.code === "ANONYMOUS_REFUSED")
        return failure("USER_IS_NOT_ANONYMOUS", 403);
      return res;
    }
    case USERNAME_SIGN_IN:
    case PHONE_SIGN_IN: {
      const key = path === USERNAME_SIGN_IN ? "username" : "phoneNumber";
      const refused = signInRefusal(body, key);
      if (refused) return refused;
      const id = body[key];
      if (typeof id !== "string" || typeof body.password !== "string")
        return failure(BETTER_AUTH_CODES.invalid_body, 400);
      const field = key === "username" ? "username" : "phone";
      const { inner, res } = await core("POST", "/password/sign-in", {
        [field]: id,
        password: body.password,
      });
      // Better Auth's two-factor plugin gates both paths, as the email sign-in.
      const gated = mapped.plugins.has("two-factor")
        ? await withTwoFactor(auth, mapped, inner, res)
        : res;
      return translate(gated, async (b) =>
        b.twoFactor !== undefined
          ? { twoFactorRedirect: true, twoFactorMethods: ["totp"] }
          : signedIn(b),
      );
    }
    case USERNAME_AVAILABLE: {
      if (typeof body.username !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
      const q = new URLSearchParams({ username: body.username });
      return translate((await core("GET", `/username/available?${q}`)).res, (b) => ({
        available: b.available === true,
      }));
    }
    case PHONE_SEND: {
      if (typeof body.phoneNumber !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
      // With a session, the code adds the number to the caller (Better Auth's
      // updatePhoneNumber); with none, it signs in. Core keys the two apart.
      // An anonymous session signs in too: core refuses /phone/add to it, and
      // its verify upgrades the anonymous user, as Better Auth's does
      // (anonymous/index.mjs after hook of /phone-number/verify; ruling 42 H1).
      const s = await auth.session(request, { refresh: false });
      const to = s && !s.user.isAnonymous ? "/phone/add" : "/phone/request";
      return translate((await core("POST", to, { phone: body.phoneNumber })).res, () => ({
        message: "code sent",
      }));
    }
    case PHONE_VERIFY:
      return phoneVerify(auth, mapped, request, body, core, signedIn, userOf);
    case ONE_TAP: {
      const extra = extraKeys(body, ["idToken"]);
      if (extra.length > 0)
        return failure(NOT_SUPPORTED, 501, `core takes no ${extra.join(", ")} at One Tap`);
      if (typeof body.idToken !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
      const { res } = await core("POST", "/social/google/id-token", { idToken: body.idToken });
      return translate(res, signedIn);
    }
    case SET_ACTIVE:
    case REVOKE_DEVICE: {
      if (typeof body.sessionToken !== "string")
        return failure(BETTER_AUTH_CODES.invalid_body, 400);
      // The list answers the session id in `token` (shapes.ts listedSession):
      // the shim never holds a clear token, and core's routes take the id.
      const sessionId = body.sessionToken;
      if (path === REVOKE_DEVICE)
        return translate(
          (await core("POST", "/multi-session/sign-out", { sessionId })).res,
          () => ({ status: true }),
        );
      return translate((await core("POST", "/multi-session/switch", { sessionId })).res, (b) =>
        sessionPair(mapped, (b.session as { id?: unknown } | undefined)?.id),
      );
    }
    default:
      return null;
  }
}

type Core = (
  method: "GET" | "POST",
  to: string,
  payload?: Body,
) => Promise<{ inner: Request; res: Response }>;

/**
 * Better Auth's `rememberMe: false` asks for a browser-session cookie and
 * `callbackURL` for a redirect. Core keeps neither, so each answers
 * NOT_SUPPORTED, as at the email sign-in (api.ts signInEmail).
 */
function signInRefusal(body: Body, key: string): Response | null {
  if (body.callbackURL !== undefined)
    return failure(NOT_SUPPORTED, 501, "core takes no callbackURL at sign-in");
  if (body.rememberMe === false)
    return failure(
      NOT_SUPPORTED,
      501,
      "core takes no rememberMe: false: every session lives session.expiresIn",
    );
  const extra = extraKeys(body, [key, "password", "rememberMe"]);
  return extra.length > 0
    ? failure(NOT_SUPPORTED, 501, `core takes no ${extra.join(", ")} at this sign-in`)
    : null;
}

/**
 * `/sign-in/social` with `idToken` (Better Auth 1.7.2
 * dist/api/routes/sign-in.mjs): core's ID-token route for google and apple
 * (plan 12i Task 10). `idToken.nonce` must be a nonce of core's
 * `POST /social/<provider>/id-token/nonce`; another nonce answers INVALID_TOKEN.
 */
async function idTokenSignIn(
  body: Body,
  core: Core,
  signedIn: (b: Body) => Promise<{ token: unknown; user: User }>,
): Promise<Response> {
  const extra = extraKeys(body, ["provider", "idToken", "disableRedirect"]);
  if (extra.length > 0)
    return failure(NOT_SUPPORTED, 501, `core takes no ${extra.join(", ")} with an ID token`);
  const provider = body.provider;
  if (typeof provider !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
  if (!ID_TOKEN_PROVIDERS.has(provider))
    return failure(NOT_SUPPORTED, 501, "core takes an ID token of google and apple only");
  const t = body.idToken;
  if (typeof t !== "object" || t === null || Array.isArray(t))
    return failure(BETTER_AUTH_CODES.invalid_body, 400);
  const token = t as Body;
  const kept = extraKeys(token, ["token", "nonce", ...UNKEPT_TOKEN_FIELDS]);
  if (kept.length > 0)
    return failure(NOT_SUPPORTED, 501, `core takes no idToken.${kept.join(", idToken.")}`);
  if (typeof token.token !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
  if (token.nonce !== undefined && typeof token.nonce !== "string")
    return failure(BETTER_AUTH_CODES.invalid_body, 400);
  const { res } = await core("POST", `/social/${provider}/id-token`, {
    idToken: token.token,
    ...(token.nonce !== undefined ? { nonce: token.nonce } : {}),
  });
  // Better Auth's answer of the ID token form: no redirect and no URL.
  return translate(res, async (b) => ({ redirect: false, ...(await signedIn(b)) }));
}

/**
 * `/phone-number/verify` (Better Auth 1.7.2 phone-number/routes.mjs:239).
 * `updatePhoneNumber` adds the number to the caller through core's add
 * route; else the code signs in through core's verify route.
 * `disableSession: true` answers NOT_SUPPORTED: core's verify always opens
 * the session that its proof earns.
 */
async function phoneVerify(
  auth: Auth,
  mapped: Mapped,
  request: Request,
  body: Body,
  core: Core,
  signedIn: (b: Body) => Promise<{ token: unknown; user: User }>,
  userOf: (id: unknown) => Promise<User>,
): Promise<Response> {
  const extra = extraKeys(body, ["phoneNumber", "code", "disableSession", "updatePhoneNumber"]);
  if (extra.length > 0)
    return failure(NOT_SUPPORTED, 501, `core takes no ${extra.join(", ")} at the phone verify`);
  if (body.disableSession === true)
    return failure(NOT_SUPPORTED, 501, "core opens the session at each phone code sign-in");
  if (typeof body.phoneNumber !== "string" || typeof body.code !== "string")
    return failure(BETTER_AUTH_CODES.invalid_body, 400);
  const s = await auth.session(request, { refresh: false });
  if (body.updatePhoneNumber === true) {
    // Better Auth answers USER_NOT_FOUND (401) with no session (routes.mjs:330).
    if (!s) return failure("USER_NOT_FOUND", 401);
    return translate(
      (await core("POST", "/phone/add/verify", { code: body.code })).res,
      async () => ({
        status: true,
        token: readToken(request.headers) ?? null,
        user: await userOf(s.user.id),
      }),
    );
  }
  // A send-otp with a session that is not anonymous went to core's add route,
  // so its code verifies there only.
  const { res } = await core("POST", "/phone/verify", { phone: body.phoneNumber, code: body.code });
  return translate(res, async (b) => {
    // The shim sets totp.gate.phone false, as Better Auth gates no phone code.
    if (b.twoFactor !== undefined) {
      const challenge = (b.twoFactor as { challenge?: unknown }).challenge;
      if (typeof challenge === "string")
        await mapped.config.storage.delete("verification", [
          { field: "valueHash", op: "eq", value: await sha256Hex(challenge) },
          { field: "purpose", op: "eq", value: "two-factor" },
        ]);
      throw new Error("authtempo compat: the phone code answered a second-factor challenge");
    }
    return { status: true, ...(await signedIn(b)) };
  });
}

/**
 * Better Auth's `{ session, user }` of a session id. The token is the id:
 * the shim never holds a clear token, as in the session list (shapes.ts).
 */
async function sessionPair(mapped: Mapped, id: unknown): Promise<{ session: Session; user: User }> {
  const storage = mapped.config.storage;
  const row =
    typeof id === "string"
      ? await storage.findOne("session", [{ field: "id", op: "eq", value: id }])
      : null;
  const user = row
    ? await storage.findOne("user", [{ field: "id", op: "eq", value: row.userId }])
    : null;
  if (!row || !user) throw new Error("authtempo compat: the active session is gone");
  return { session: toSession(row, row.id), user: toUser(user) };
}

/**
 * `GET /multi-session/list-device-sessions`: each session of the browser
 * as Better Auth's `{ session, user }`, from core's list. Two reads of
 * storage for any count: the sessions by id, then their users.
 */
async function deviceSessions(mapped: Mapped, core: Core): Promise<Response> {
  const storage = mapped.config.storage;
  return translate((await core("GET", "/multi-session")).res, async (b) => {
    const listed = Array.isArray(b.sessions) ? (b.sessions as { sessionId?: unknown }[]) : [];
    const ids = listed.map((x) => x.sessionId).filter((x): x is string => typeof x === "string");
    if (ids.length === 0) return [];
    const rows = await storage.findMany("session", [{ field: "id", op: "in", value: ids }]);
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = await storage.findMany("user", [{ field: "id", op: "in", value: userIds }]);
    const byId = new Map<string, UserRow>(users.map((u) => [u.id, u]));
    // Core's order: the active session first.
    return ids.flatMap((id) => {
      const row = rows.find((r) => r.id === id);
      const user = row ? byId.get(row.userId) : undefined;
      return row && user ? [{ session: toSession(row, row.id), user: toUser(user) }] : [];
    });
  });
}

/**
 * One of these paths for `auth.api` (plan 12i Task 16): the handler's own
 * steps with the caller's headers, so the two answer alike. A refusal
 * throws `APIError` with the path's code and status. A path of a plugin
 * that is off throws 404, as Better Auth has no such call then.
 */
export async function signInAdditionsCall(
  auth: Auth,
  mapped: Mapped,
  method: "GET" | "POST",
  path: string,
  input: { body?: unknown; headers?: Headers | undefined },
): Promise<unknown> {
  const headers = new Headers(input.headers);
  if (method === "POST") headers.set("content-type", "application/json");
  const request = new Request(`${mapped.origin}${mapped.basePath}${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
  });
  const res = await signInAdditionsRoute(auth, mapped, request);
  if (res === null) throw apiError("not_found", 404);
  const body = (await res.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  if (res.ok) return body;
  throw new APIError(res.status, {
    ...(typeof body?.code === "string" ? { code: body.code } : {}),
    ...(typeof body?.message === "string" ? { message: body.message } : {}),
  });
}
