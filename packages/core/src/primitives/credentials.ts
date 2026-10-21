import { DEFAULT_SESSION_COOKIE, LEGACY_SESSION_COOKIE, readCookie } from "../http/cookies.js";

/**
 * The facts of each credential that core issues (plan 11d, spec 20). The
 * engine and every SDK read them here, so each fact has one copy. This module
 * imports the cookie module only: an SDK bundle pulls no engine module for them.
 */

/** A session token: `ts_` and 32 random bytes as base64url (spec 8.1). */
export const SESSION_TOKEN_PREFIX = "ts_";

/** An API token: `tk_` and 32 random bytes as base64url (spec 8.8). */
export const API_TOKEN_PREFIX = "tk_";

/** An organization token: `to_` and 32 random bytes as base64url (plan 12k, spec 29 item 14). */
export const ORGANIZATION_TOKEN_PREFIX = "to_";

/** A SCIM token of an organization's directory: `sk_` and 32 random bytes as base64url (plan 12d). */
export const SCIM_TOKEN_PREFIX = "sk_";

/**
 * Every prefix of a credential that core issues, `to_` (organization tokens,
 * plan 12k) and `sk_` (SCIM tokens, plan 12d) included. A moved key prefix (`tokens.movedPrefixes`)
 * may not shadow one of them (ruling 12 of plan 12k). A test reads each
 * `randomToken` call of core against this list.
 */
export const CORE_PREFIXES: readonly string[] = Object.freeze([
  "ts_",
  "tk_",
  "to_",
  "cs_",
  "cl_",
  "ml_",
  "hs_",
  "hc_",
  "ps_",
  "inv_",
  "oc_",
  "od_",
  "oq_",
  "or_",
  "os_",
  "tf_",
  "td_",
  "ad_",
  "ec_",
  "pv_",
  "pr_",
  "sk_",
]);

/** A moved key prefix: a lower-case letter, at most 15 more letters or digits, and `_`. */
const MOVED_PREFIX_RE = /^[a-z][a-z0-9]{0,15}_$/;

/**
 * Why a moved key prefix (`tokens.movedPrefixes`, rulings 4 and 12 of plan
 * 12k) is refused, or null. "form": it fails `MOVED_PREFIX_RE`. "shadow": a
 * core prefix starts it, or it starts a core prefix. Core's config and the
 * verifier read this one rule.
 */
export function movedPrefixFault(prefix: string): "form" | "shadow" | null {
  if (!MOVED_PREFIX_RE.test(prefix)) return "form";
  // A moved key with a core prefix would reach a core lookup, and a core credential would reach the moved one.
  if (CORE_PREFIXES.some((c) => c.startsWith(prefix) || prefix.startsWith(c))) return "shadow";
  return null;
}

/** The header `typ` of a session JWT and of an ID token (spec 8.12). */
export const SESSION_JWT_TYPE = "JWT";

/** The header `typ` of an OAuth access token (RFC 9068, spec 8.13). */
export const ACCESS_TOKEN_TYPE = "at+jwt";

/**
 * The session cookie name when the config sets no `cookieName`:
 * `__Host-tempo_session` since plan 12b. The value has one copy, in
 * `http/cookies.ts`; this name is the SDK name for it (plan 11d).
 */
export const DEFAULT_COOKIE_NAME = DEFAULT_SESSION_COOKIE;

/**
 * The session cookie name before plan 12b. Core reads it for one release when
 * `cookieName` is the default. An SDK passes it as `legacyCookieName` to
 * `readSessionToken` for that release (row 12j removes the read).
 */
export const LEGACY_COOKIE_NAME = LEGACY_SESSION_COOKIE;

/** The cookie names that `readSessionToken` reads: `legacyCookieName` only for the plan 12b move. */
export interface SessionCookieNames {
  cookieName: string;
  legacyCookieName?: string | null;
}

/**
 * The session cookie names of a `cookieName` setting: the old name is read
 * only when the name is the default (plan 12b). The one copy of this rule:
 * the config and every SDK call it (plan 11d).
 */
export function sessionCookieNames(cookieName?: string): {
  cookieName: string;
  legacyCookieName: string | null;
} {
  const name = cookieName ?? DEFAULT_COOKIE_NAME;
  return {
    cookieName: name,
    legacyCookieName: name === DEFAULT_COOKIE_NAME ? LEGACY_COOKIE_NAME : null,
  };
}

/** The value of `Authorization: Bearer <value>`, or null. The one copy of the bearer rule. */
export function readBearer(request: Pick<Request, "headers">): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

/**
 * The value of `Authorization: DPoP <token>`, or null (RFC 9449 section 7.1).
 * The one copy of the DPoP scheme rule: core and the verifier read it here.
 */
export function readDpopToken(request: Pick<Request, "headers">): string | null {
  const m = /^DPoP\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

/**
 * The cookie wins over the bearer header, so a web page cannot be overridden by a stray header.
 * Public from `@authtempo/core` since plan 9 Task 4, 2026-10-10: the Better Auth shim reads
 * the session token with this function, so the cookie and bearer rule has one copy. It reads
 * only `cookieName`, `legacyCookieName`, and the headers, so the shim passes
 * `{ cookieName, legacyCookieName }` and `{ headers }`. Since plan 12b it also reads the old cookie name when the config names
 * one (`legacyCookieName`), for one release.
 */
export function readSessionToken(
  config: SessionCookieNames,
  request: Pick<Request, "headers">,
): string | null {
  return sessionCookieToken(config, request) ?? readBearer(request);
}

/**
 * The session token of the cookie: `cookieName`, then `legacyCookieName` for
 * one release (plan 12b), or null. The one copy of the cookie read:
 * `readSessionToken` and `callerFromRequest` both call it.
 */
export function sessionCookieToken(
  config: SessionCookieNames,
  request: Pick<Request, "headers">,
): string | null {
  const cookie = readCookie(request, config.cookieName);
  if (cookie) return cookie;
  const legacy = config.legacyCookieName ? readCookie(request, config.legacyCookieName) : null;
  return legacy || null;
}
