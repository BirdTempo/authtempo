import type { ResolvedConfig } from "../../config.js";
import type { Route } from "../router.js";
import { emailOtpRoutes } from "./email-otp.js";
import { handoffRoutes } from "./handoff.js";
import { jwtRoutes } from "./jwt.js";
import { magicLinkRoutes } from "./magic-link.js";
import { oauthRoutes } from "./oauth.js";
import { operatorRoutes } from "./operator.js";
import { organizationRoutes } from "./organizations.js";
import { passkeyRoutes } from "./passkeys.js";
import { passwordRoutes } from "./password.js";
import { reauthRoutes } from "./reauth.js";
import { secondFactorRoutes } from "./second-factor.js";
import { sessionRoutes } from "./sessions.js";
import { socialRoutes } from "./social.js";
import { tokenRoutes } from "./tokens.js";
import { totpRoutes } from "./totp.js";

/**
 * Every route of a config, in the router's order. One function, so that the
 * route list test of plan 11a reads the same routes that `createAuth` mounts.
 */
export function coreRoutes(config: ResolvedConfig): Route[] {
  return [
    ...sessionRoutes(config),
    ...reauthRoutes(config),
    ...magicLinkRoutes(config),
    ...socialRoutes(config),
    ...passkeyRoutes(config),
    ...passwordRoutes(config),
    ...totpRoutes(config),
    ...secondFactorRoutes(config),
    ...emailOtpRoutes(config),
    ...handoffRoutes(config),
    ...organizationRoutes(config),
    ...tokenRoutes(config),
    ...jwtRoutes(config),
    ...operatorRoutes(config),
    ...oauthRoutes(config),
  ];
}
