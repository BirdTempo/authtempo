import { ROUTES, type RouteFeature, type RouteKey } from "../http/route-list.js";

/**
 * The config key and the default of each feature (plan 11g). Each tag and
 * each operation of the OpenAPI document carries them. "always on" names a
 * feature that every deployment serves. A test holds the defaults to the
 * routes of a minimal config.
 */
export const FEATURE_INFO: Record<RouteFeature, { configKey: string; default: "on" | "off" }> = {
  session: { configKey: "always on", default: "on" },
  account: { configKey: "always on", default: "on" },
  accountDelete: { configKey: "account.delete", default: "on" },
  magicLink: { configKey: "always on", default: "on" },
  social: { configKey: "social", default: "off" },
  passkey: { configKey: "passkey", default: "off" },
  password: { configKey: "password", default: "off" },
  totp: { configKey: "totp", default: "off" },
  emailOtp: { configKey: "emailOtp", default: "on" },
  emailOtpReset: { configKey: "emailOtp and password", default: "off" },
  handoff: { configKey: "handoff", default: "off" },
  organizations: { configKey: "organizations", default: "off" },
  dynamicRoles: { configKey: "organizations.dynamicRoles", default: "off" },
  teams: { configKey: "organizations.teams", default: "off" },
  tokens: { configKey: "always on", default: "on" },
  jwtMint: { configKey: "jwtMint", default: "on" },
  operator: { configKey: "operator", default: "off" },
  operatorUsers: { configKey: "operator.users", default: "off" },
  operatorImpersonation: { configKey: "operator.impersonation", default: "off" },
  oauth: { configKey: "oauth", default: "off" },
  oauthRegistration: { configKey: "oauth.registration.dynamic", default: "off" },
  oauthDevice: { configKey: "oauth.device", default: "off" },
  openapi: { configKey: "openapi", default: "off" },
};

const FEATURE_OF: ReadonlyMap<string, RouteFeature> = new Map(
  ROUTES.map((r) => [`${r.method} ${r.path}`, r.feature]),
);

/** The features of a list of routes, read from the entry of each route's key. */
export function featuresOf(routes: readonly { key: RouteKey }[]): Set<RouteFeature> {
  const features = new Set<RouteFeature>();
  for (const route of routes) {
    const feature = FEATURE_OF.get(route.key);
    if (feature === undefined)
      throw new Error(`authtempo: no route entry has the key ${route.key}`);
    features.add(feature);
  }
  return features;
}

/**
 * The keys of mounted routes. A mounted route with no key is a failure, never
 * a skip: the document would lose its feature with no sign (plan 11g, ruling 3).
 */
export function keyedRoutes(
  routes: readonly { method: string; path: string; key?: RouteKey }[],
): { key: RouteKey }[] {
  return routes.map((route) => {
    if (route.key === undefined)
      throw new Error(`authtempo: the route ${route.method} ${route.path} has no key`);
    return { key: route.key };
  });
}
