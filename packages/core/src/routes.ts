/**
 * The route facts for an SDK (plan 11d, spec 20): every route that core can
 * serve, with literal types; the name rule of `:provider`; and the query
 * parameter of a browser flow failure. An SDK imports this entry, never
 * `@authtempo/core/testing`, which also holds the soft authenticator.
 */

export { AUTH_ERROR_PARAM } from "./http/redirect.js";
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
} from "./http/route-list.js";
export { PROVIDER_NAME_RE } from "./social/provider.js";
