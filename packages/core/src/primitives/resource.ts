/**
 * A resource identifier that core accepts (RFC 8707 section 2): an http or
 * https URL of at most 2048 characters, with no query, no fragment, and no
 * user info. The config check of `oauth.resources` and `resourceOf` both
 * call this one copy (plan 11d).
 */
export function isResourceUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048 || value.includes("#")) return false;
  try {
    const u = new URL(value);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.search === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * The resource of `resources` that a request URL falls under, or null: a
 * resource on the URL's origin whose path is the URL's path or a parent of
 * it at a `/` boundary, the longest first (spec 8.13 item 4, RFC 8707). An
 * access token passes only for this resource. Core's `requestResource` and
 * the verifier of `@authtempo/verify` both call this one copy (plan 11d).
 * It skips a resource that fails `isResourceUrl`, so a caller that does not
 * check its list first gets null for that entry, never a throw.
 */
export function resourceOf(resources: readonly string[], url: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestLength = -1;
  for (const resource of resources) {
    if (!isResourceUrl(resource)) continue;
    const r = new URL(resource);
    if (r.origin !== target.origin) continue;
    const base = r.pathname.replace(/\/$/, "");
    if (base !== "" && target.pathname !== base && !target.pathname.startsWith(`${base}/`))
      continue;
    if (base.length > bestLength) {
      best = resource;
      bestLength = base.length;
    }
  }
  return best;
}
