/**
 * The anchors of the docs (plan 11g): the routes page, the errors page, and
 * the docs origin. The OpenAPI document links them, the client links the
 * errors page, and the site's checks read them, so each rule has one copy.
 */

/** The origin of the docs. A link goes to a page under `/docs/`. */
export const DOCS_ORIGIN = "https://authtempo.com";

/** The table of a code: `ERRORS` or `OAUTH_ERRORS`. Two codes are in both. */
export type ErrorTable = "core" | "oauth";

/** The anchor of a route on /docs/reference/routes/: the method, then the path with each run of other characters as one hyphen. */
export function routeAnchor(method: string, path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${method.toLowerCase()}-${slug}`;
}

/**
 * The anchor of a code on `/docs/reference/errors/`: the code for `ERRORS`,
 * `oauth-` and the code for `OAUTH_ERRORS`, because `invalid_token` and
 * `rate_limited` are in both and one page cannot hold one id twice (spec 18
 * rule 8). The site's checks import this one copy.
 */
export function errorAnchor(code: string, table: ErrorTable): string {
  return table === "core" ? code : `oauth-${code}`;
}
