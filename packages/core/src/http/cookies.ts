/**
 * The default session cookie (plan 12b, owner decision 3). The `__Host-`
 * prefix makes a browser refuse the cookie unless it is `Secure`, has
 * `Path=/`, and has no `Domain`, so a sibling subdomain cannot set it for
 * the parent domain. The rest of the name keeps the old product name
 * tempo-auth, as the table prefix `ta_` does.
 */
export const DEFAULT_SESSION_COOKIE = "__Host-tempo_session";
/**
 * The session cookie before plan 12b. For one release core reads it when a
 * request carries no `__Host-tempo_session`, and moves it (the router). The
 * release after removes the read (row 12j). Load-bearing: a browser of a
 * deployed app holds this name.
 */
export const LEGACY_SESSION_COOKIE = "tempo_session";

/**
 * The binding cookie of a social sign-in. Its path is `<basePath>/social`,
 * and a browser drops a `__Host-` cookie whose path is not `/`, so the name
 * drops that prefix and takes `__Secure-` (plan 12b).
 */
export function bindingCookieName(cookieName: string): string {
  return `__Secure-${cookieName.replace(/^__(Host|Secure)-/, "")}_oauth`;
}

export type SameSite = "Lax" | "None";

export function sessionCookie(
  name: string,
  token: string,
  maxAgeSeconds: number,
  sameSite: SameSite,
): string {
  return `${name}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=${sameSite}`;
}

export function clearSessionCookie(name: string, sameSite: SameSite): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`;
}

/** Only the headers are read, so a caller with a `Headers` and no `Request` can pass `{ headers }`. */
export function readCookie(request: Pick<Request, "headers">, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * The binding cookie of a social sign-in. `SameSite=None` because Apple
 * posts the callback from its own origin, and a Lax cookie is not sent on
 * a cross-site POST. The path limits it to the social routes.
 */
export function oauthCookie(
  name: string,
  value: string,
  path: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=None`;
}

export function clearOauthCookie(name: string, path: string): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=None`;
}

/**
 * The trusted-device cookie (plan 9f). The path limits it to the auth
 * routes, where the password sign-in reads it. SameSite is the session
 * cookie's.
 */
export function trustCookie(
  name: string,
  token: string,
  path: string,
  maxAgeSeconds: number,
  sameSite: SameSite,
): string {
  return `${name}=${token}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=${sameSite}`;
}

export function clearTrustCookie(name: string, path: string, sameSite: SameSite): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`;
}
