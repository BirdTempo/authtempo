import type { PasskeySummaryJSON } from "@authtempo/client";
import type { Auth, SessionSummary } from "@authtempo/core";
import {
  APIError,
  BETTER_AUTH_CODES,
  COMPAT_CODES,
  type CompatCode,
  compatApiError,
  messageOf,
} from "../errors.js";
import {
  accountsOf,
  CREDENTIAL_UNLINK,
  type DeleteUserBody,
  deleteUserChecks,
  isCredential,
  profilePatch,
  sessionIdOf,
} from "./api.js";
import { translate } from "./email-otp.js";
import type { Mapped } from "./map-options.js";
import { listedSession, toNext, toPasskey } from "./shapes.js";

/**
 * Better Auth 1.7.2's account paths (dist/api/routes/session.mjs,
 * update-user.mjs, and account.mjs, read 2026-10-17), and the passkey rename
 * of @better-auth/passkey 1.7.2 (dist/index.mjs:630, Task 19), served by
 * `auth.handler` in Better Auth's shapes (plan 12a). Each posts core's own
 * route, so core's router applies its Origin rule, its fetch-metadata rule,
 * CORS, and the cookie renewals. The shim keeps only Better Auth's checks
 * and shapes, in the helpers that `auth.api` calls too (api.ts).
 */
export const ACCOUNT_PATHS: readonly string[] = [
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/update-user",
  "/delete-user",
  "/change-email",
  "/list-accounts",
  "/link-social",
  "/unlink-account",
  "/passkey/update-passkey",
];

/** The GET paths. Every other path is a POST. */
const GET_PATHS: readonly string[] = ["/list-sessions", "/list-accounts"];

/**
 * Better Auth 1.7.2's link-social fields that core cannot keep
 * (account.mjs:77 to :133). Core starts a redirect link only, with its own
 * scopes and its own error page, so each would be dropped in silence.
 */
const LINK_NOT_SUPPORTED = [
  "idToken",
  "scopes",
  "additionalData",
  "additionalParams",
  "requestSignUp",
  "loginHint",
  "errorCallbackURL",
];

type Body = Record<string, unknown>;

/**
 * An answer of the shim's own, before any core route runs: a check of the
 * body or of an option. It changes no row. It carries no CORS header, as
 * the shim's own refusals of plans 9e and 9f do not.
 */
function failure(e: APIError): Response {
  return Response.json(e.body, { status: e.statusCode });
}

/** The JSON object of a POST, or null for no object. */
async function bodyOf(request: Request): Promise<Body | null> {
  const v: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : null;
}

/** A string field, or undefined. Any other present value answers VALIDATION_ERROR, as Better Auth's schema does. */
function text(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new APIError(400, BETTER_AUTH_CODES.invalid_body);
  return v;
}

/** A required string field. */
function required(body: Body, key: string): string {
  const v = text(body, key);
  if (v === undefined) throw new APIError(400, BETTER_AUTH_CODES.invalid_body);
  return v;
}

/**
 * Core's answer in Better Auth's shape. `map` names core codes that answer
 * another way here: `"ok"` answers the success, and a shim code answers that
 * code with its status. The headers stay core's.
 */
async function answer(
  res: Response,
  success: (body: Body) => unknown | Promise<unknown>,
  map: Partial<Record<string, CompatCode | "ok">> = {},
): Promise<Response> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as Body | null;
  const to = typeof body?.error === "string" ? map[body.error] : undefined;
  if (to === undefined) return translate(res, success);
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (to === "ok") return Response.json(await success({}), { status: 200, headers });
  return Response.json({ code: to, message: messageOf(to) }, { status: COMPAT_CODES[to], headers });
}

/** The answer to one of the eleven paths, or null for any other request. */
export async function accountRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${mapped.basePath}/`)) return null;
  const path = pathname.slice(mapped.basePath.length);
  if (!ACCOUNT_PATHS.includes(path)) return null;
  // Any other method, an OPTIONS preflight too, goes to core's router.
  if (request.method !== (GET_PATHS.includes(path) ? "GET" : "POST")) return null;
  // Without the passkey plugin, core's router answers the path 404, as for any path it does not serve.
  if (path === "/passkey/update-passkey" && !mapped.config.passkey) return null;
  /** One core route with the caller's headers: the cookie, the Origin, and the client IP. */
  const core = (method: "GET" | "POST", to: string, body?: Body) => {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    if (body !== undefined) headers.set("content-type", "application/json");
    return auth.handle(
      new Request(`${mapped.origin}${mapped.basePath}${to}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  const status = () => ({ status: true });
  /** The caller, after core's route proved the session. */
  const caller = async () => {
    const s = await auth.session(request, { refresh: false });
    if (!s) throw new Error("authtempo compat: the session of an answered request is gone");
    return s;
  };
  try {
    if (path === "/list-sessions")
      return answer(await core("GET", "/sessions"), async (b) => {
        const userId = (await caller()).user.id;
        // Core's JSON holds each date as text, and the answer writes it back as the same text.
        return (b.sessions as SessionSummary[]).map((x) => listedSession(x, userId));
      });
    if (path === "/list-accounts")
      return answer(await core("GET", "/identities"), async () =>
        accountsOf(mapped.config.storage, (await caller()).user.id),
      );
    // A path with no field may come with no body. A missing field answers VALIDATION_ERROR.
    const body = (await bodyOf(request)) ?? {};
    switch (path) {
      case "/revoke-session": {
        const token = required(body, "token");
        // A read with no write: core's route does the one sliding refresh and sends its renewal cookie (Task 14 review L1).
        const s = await auth.session(request, { refresh: false });
        // With no session, core's route answers 401.
        const id = s ? await sessionIdOf(mapped.config.storage, s.user.id, token) : token;
        // Better Auth 1.7.2 answers status true for a token it does not know
        // (dist/api/routes/session.mjs:398 to :408, read 2026-10-17).
        return answer(await core("POST", "/sessions/revoke", { id }), status, {
          not_found: "ok",
          invalid_body: "ok",
        });
      }
      case "/revoke-other-sessions":
        return answer(await core("POST", "/sessions/revoke-others", {}), status);
      case "/revoke-sessions": {
        const others = await core("POST", "/sessions/revoke-others", {});
        if (!others.ok) return answer(others, status);
        // Core's own revoke of the caller's session clears the cookie by core's rule.
        const own = (await caller()).session.id;
        return answer(await core("POST", "/sessions/revoke", { id: own }), status);
      }
      case "/update-user":
        return answer(await core("POST", "/user/update", profilePatch(body)), status);
      case "/change-email": {
        const newEmail = required(body, "newEmail");
        // Better Auth 1.7.2's answer with the option off (update-user.mjs:440 to :443).
        if (!mapped.account.changeEmail) throw compatApiError("CHANGE_EMAIL_DISABLED");
        const next = toNext(text(body, "callbackURL"), mapped.appOrigin);
        if (next === null) throw compatApiError("INVALID_CALLBACK_URL");
        return answer(
          await core("POST", "/user/change-email", {
            newEmail,
            ...(next !== undefined ? { next } : {}),
          }),
          status,
        );
      }
      case "/unlink-account": {
        const accountId = required(body, "accountId");
        // A read with no write: core's route does the one sliding refresh and sends its renewal cookie (Task 14 review L1).
        const s = await auth.session(request, { refresh: false });
        if (s && (await isCredential(mapped.config.storage, s.user.id, accountId))) {
          // Better Auth 1.7.2 checks the fresh rule first (account.mjs:266).
          const fresh = auth.api.session.requireFresh(s);
          if (!fresh.ok) throw new APIError(fresh.status, BETTER_AUTH_CODES.session_not_fresh);
          throw compatApiError("NOT_SUPPORTED", CREDENTIAL_UNLINK);
        }
        // Core answers not_found for an unknown id and invalid_body for its own email identity.
        return answer(await core("POST", "/identities/unlink", { id: accountId }), status, {
          not_found: "ACCOUNT_NOT_FOUND",
          invalid_body: "ACCOUNT_NOT_FOUND",
        });
      }
      case "/delete-user": {
        const fields: DeleteUserBody = {};
        for (const key of ["password", "token", "callbackURL"] as const) {
          const v = text(body, key);
          if (v !== undefined) fields[key] = v;
        }
        deleteUserChecks(mapped, fields);
        if (fields.password !== undefined) {
          // Better Auth's password path skips freshAge (update-user.mjs:335): core's re-authentication first.
          const reauth = await core("POST", "/reauth", { password: fields.password });
          if (!reauth.ok) return answer(reauth, status);
        }
        // Core's delete ends the session and clears the cookie by core's rule.
        return answer(await core("POST", "/user/delete", {}), () => ({
          success: true,
          message: "User deleted",
        }));
      }
      case "/passkey/update-passkey": {
        const id = required(body, "id");
        // Better Auth 1.7.2 trims the name, then needs one character
        // (@better-auth/passkey dist/index.mjs:634). Core refuses an empty name.
        const name = required(body, "name").trim();
        return answer(
          await core("POST", "/passkeys/rename", { id, name }),
          async (b) => ({
            passkey: toPasskey(b.passkey as PasskeySummaryJSON, (await caller()).user.id),
          }),
          // Better Auth answers 401 for another user's passkey (authorization.mjs:35).
          // Core answers it as an unknown id, so the answer tells nothing of it.
          { not_found: "PASSKEY_NOT_FOUND" },
        );
      }
      case "/link-social": {
        const refused = LINK_NOT_SUPPORTED.filter((k) => body[k] !== undefined);
        if (refused.length > 0)
          throw compatApiError("NOT_SUPPORTED", `core takes no ${refused.join(", ")} at the link`);
        const provider = required(body, "provider");
        const next = toNext(text(body, "callbackURL"), mapped.appOrigin);
        if (next === null) throw compatApiError("INVALID_CALLBACK_URL");
        const disableRedirect = body.disableRedirect;
        if (disableRedirect !== undefined && typeof disableRedirect !== "boolean")
          throw new APIError(400, BETTER_AUTH_CODES.invalid_body);
        return answer(
          await core(
            "POST",
            `/social/${encodeURIComponent(provider)}/link`,
            next !== undefined ? { next } : {},
          ),
          // Better Auth 1.7.2's answer (account.mjs:257 to :260). Core's headers keep the binding cookie.
          (b) => ({ url: b.url, redirect: disableRedirect !== true }),
        );
      }
    }
    return null;
  } catch (e) {
    if (e instanceof APIError) return failure(e);
    throw e;
  }
}
