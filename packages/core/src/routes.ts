/**
 * The route facts for an SDK (plan 11d, spec 20): every route that core can
 * serve, with literal types; the name rule of `:provider`; the segment
 * rule of every other `:<name>` (plan 12d); the query parameter of a
 * browser flow failure; and the closed set of the last method cookie with
 * its guard (plan 12i). An SDK imports this entry, never
 * `@authtempo/core/testing`, which also holds the soft authenticator.
 */

export { isLastMethod, LAST_METHODS, type LastMethod } from "./engine/last-method.js";
export { DOCS_ORIGIN, type ErrorTable, errorAnchor, routeAnchor } from "./http/anchors.js";
export { DEFAULT_LAST_METHOD_COOKIE } from "./http/cookies.js";
export { AUTH_ERROR_PARAM } from "./http/redirect.js";
export { PARAM_SEGMENT_RE } from "./http/route-key.js";
export {
  type AuthForm,
  ROUTE_FEATURES,
  ROUTER_CODES,
  ROUTES,
  type RouteEntry,
  type RouteFeature,
  type RouteKey,
  type RouteLiteral,
  type RouteMethod,
  type RoutePath,
  type RouterCode,
  USER_ACTOR_CODES,
} from "./http/route-list.js";
export { PROVIDER_NAME_RE } from "./social/provider.js";
