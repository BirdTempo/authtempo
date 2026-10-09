export function sessionCookie(name: string, token: string, maxAgeSeconds: number): string {
  return `${name}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
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
