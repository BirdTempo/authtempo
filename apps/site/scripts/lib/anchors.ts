/** The anchor of a route on /docs/reference/routes/: the method, then the path with each run of other characters as one hyphen. */
export function routeAnchor(method: string, path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${method.toLowerCase()}-${slug}`;
}

/**
 * The anchor of an error code on /docs/reference/errors/. The rule lives in
 * `@authtempo/client` (plan 11d), whose `errorDocsURL` links to it; this file
 * re-exports the one copy.
 */
export { errorAnchor } from "@authtempo/client";
