/**
 * The resource of `resources` that a request URL falls under, or null: a
 * resource on the URL's origin whose path is the URL's path or a parent of
 * it at a `/` boundary, the longest first (spec 8.13 item 4, RFC 8707). An
 * access token passes only for this resource. Core's `requestResource` and
 * the verifier of `@authtempo/verify` both call this one copy (plan 11d).
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
