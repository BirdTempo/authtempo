import type { ResolvedConfig } from "../../config.js";
import { healthRoutes } from "../health.js";
import type { Route } from "../router.js";
import { emailOtpRoutes } from "./email-otp.js";
import { handoffRoutes } from "./handoff.js";
import { identityRoutes } from "./identities.js";
import { jwtRoutes } from "./jwt.js";
import { magicLinkRoutes } from "./magic-link.js";
import { oauthRoutes } from "./oauth.js";
import { openApiRoutes } from "./openapi.js";
import { operatorRoutes } from "./operator.js";
import { organizationRoutes } from "./organizations.js";
import { passkeyRoutes } from "./passkeys.js";
import { passwordRoutes } from "./password.js";
import { reauthRoutes } from "./reauth.js";
import { roleRoutes } from "./roles.js";
import { secondFactorRoutes } from "./second-factor.js";
import { sessionRoutes } from "./sessions.js";
import { socialRoutes } from "./social.js";
import { teamRoutes } from "./teams.js";
import { tokenRoutes } from "./tokens.js";
import { totpRoutes } from "./totp.js";
import { userRoutes } from "./user.js";

/**
 * The name of one route module file under `src/http/routes/` (plan 11g).
 * `health` is `src/http/health.ts` (plan 12h Task 8).
 */
export type RouteModule =
  | "sessions"
  | "reauth"
  | "user"
  | "identities"
  | "magic-link"
  | "social"
  | "passkeys"
  | "password"
  | "totp"
  | "second-factor"
  | "email-otp"
  | "handoff"
  | "organizations"
  | "roles"
  | "teams"
  | "tokens"
  | "jwt"
  | "operator"
  | "oauth"
  | "openapi"
  | "health";

/**
 * Every route of a config, by module, in the router's order (plan 11g). The
 * module tie test holds each route's entry to the features of its module.
 */
export function coreRouteModules(
  config: ResolvedConfig,
): readonly { module: RouteModule; routes: Route[] }[] {
  const list: { module: RouteModule; routes: Route[] }[] = [
    { module: "sessions", routes: sessionRoutes(config) },
    { module: "reauth", routes: reauthRoutes(config) },
    { module: "user", routes: userRoutes(config) },
    { module: "identities", routes: identityRoutes(config) },
    { module: "magic-link", routes: magicLinkRoutes(config) },
    { module: "social", routes: socialRoutes(config) },
    { module: "passkeys", routes: passkeyRoutes(config) },
    { module: "password", routes: passwordRoutes(config) },
    { module: "totp", routes: totpRoutes(config) },
    { module: "second-factor", routes: secondFactorRoutes(config) },
    { module: "email-otp", routes: emailOtpRoutes(config) },
    { module: "handoff", routes: handoffRoutes(config) },
    { module: "organizations", routes: organizationRoutes(config) },
    { module: "roles", routes: roleRoutes(config) },
    { module: "teams", routes: teamRoutes(config) },
    { module: "tokens", routes: tokenRoutes(config) },
    { module: "jwt", routes: jwtRoutes(config) },
    { module: "operator", routes: operatorRoutes(config) },
    { module: "oauth", routes: oauthRoutes(config) },
    { module: "health", routes: healthRoutes(config) },
  ];
  // The thunk reads the final list at the first request, so the document lists this route too.
  list.push({
    module: "openapi",
    routes: openApiRoutes(config, () => list.flatMap((m) => m.routes)),
  });
  return list;
}

/**
 * Every route of a config, in the router's order. One function, so that the
 * route list test of plan 11a reads the same routes that `createAuth` mounts.
 */
export function coreRoutes(config: ResolvedConfig): Route[] {
  return coreRouteModules(config).flatMap((m) => m.routes);
}
