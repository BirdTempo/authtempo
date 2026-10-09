export type Returned = { ok: true; params: Record<string, string> } | { ok: false };

/**
 * The app's own parser for the URL the browser handed back. It never uses
 * `URL`: Hermes ships an incomplete one. The URL must be the configured
 * redirect exactly, or the redirect followed by `?` (or `&` when the
 * redirect already has a query) and a query. Case, host, and path must
 * match byte for byte; a fragment is refused.
 */
export function parseReturnedUrl(redirect: string, url: string): Returned {
  if (url.includes("#")) return { ok: false };
  if (url === redirect) return { ok: true, params: {} };
  const q = redirect.indexOf("?");
  const sep = q >= 0 ? "&" : "?";
  if (!url.startsWith(redirect + sep)) return { ok: false };
  // The whole query, including a dev redirect's own pairs, which come first.
  const query = q >= 0 ? url.slice(q + 1) : url.slice(redirect.length + 1);
  // No prototype, so a key such as `constructor` cannot read an inherited value.
  const params: Record<string, string> = Object.create(null);
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = decode(i < 0 ? pair : pair.slice(0, i));
    const v = decode(i < 0 ? "" : pair.slice(i + 1));
    if (k === null || v === null) return { ok: false };
    if (!(k in params)) params[k] = v;
  }
  return { ok: true, params };
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return null;
  }
}
