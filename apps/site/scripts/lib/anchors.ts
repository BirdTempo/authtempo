/** The anchor of a route on /docs/reference/routes/: the method, then the path with each run of other characters as one hyphen. */
export function routeAnchor(method: string, path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${method.toLowerCase()}-${slug}`;
}

/**
 * The anchor of an error code on /docs/reference/errors/. `invalid_token` and
 * `rate_limited` are in both tables, and one page cannot hold one id twice,
 * so a code of OAUTH_ERRORS takes the prefix `oauth-`.
 */
export function errorAnchor(code: string, table: "core" | "oauth"): string {
  return table === "core" ? code : `oauth-${code}`;
}
