/**
 * The anchor of a route on /docs/reference/routes/ and of an error code on
 * /docs/reference/errors/. The rules live in `@authtempo/core/routes` (plan
 * 11g), whose OpenAPI document and client links read them; this file
 * re-exports the one copy.
 */
export { errorAnchor, routeAnchor } from "@authtempo/core/routes";
