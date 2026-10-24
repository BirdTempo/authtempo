import type { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { EMAIL_OTP_CONTRACT } from "./email-otp.js";
import { HANDOFF_CONTRACT } from "./handoff.js";
import { HEALTH_CONTRACT } from "./health.js";
import { IDENTITIES_CONTRACT } from "./identities.js";
import { JWT_CONTRACT } from "./jwt.js";
import { MAGIC_LINK_CONTRACT } from "./magic-link.js";
import { OAUTH_CONTRACT } from "./oauth.js";
import { OPENAPI_CONTRACT } from "./openapi.js";
import { OPERATOR_CONTRACT } from "./operator.js";
import { ORGANIZATIONS_CONTRACT } from "./organizations.js";
import { PASSKEYS_CONTRACT } from "./passkeys.js";
import { PASSWORD_CONTRACT } from "./password.js";
import { REAUTH_CONTRACT } from "./reauth.js";
import { ROLES_CONTRACT } from "./roles.js";
import { SCIM_CONTRACT } from "./scim.js";
import { SECOND_FACTOR_CONTRACT } from "./second-factor.js";
import { SESSIONS_CONTRACT } from "./sessions.js";
import { SOCIAL_CONTRACT } from "./social.js";
import { SSO_CONTRACT } from "./sso.js";
import { TEAMS_CONTRACT } from "./teams.js";
import { TOKENS_CONTRACT } from "./tokens.js";
import { TOTP_CONTRACT } from "./totp.js";
import type { RouteContract } from "./types.js";
import { USER_CONTRACT } from "./user.js";

/**
 * The contract of every route of `ROUTES` (plan 11g), one module after
 * another in the router's order. `satisfies Record<RouteKey, …>` holds it
 * both ways: a route with no contract and a contract with no route fail
 * the compile. The OpenAPI generator reads it; the routes parse with the
 * same schemas.
 */
export const ROUTE_CONTRACT = {
  ...SESSIONS_CONTRACT,
  ...REAUTH_CONTRACT,
  ...USER_CONTRACT,
  ...IDENTITIES_CONTRACT,
  ...MAGIC_LINK_CONTRACT,
  ...SOCIAL_CONTRACT,
  ...PASSKEYS_CONTRACT,
  ...PASSWORD_CONTRACT,
  ...TOTP_CONTRACT,
  ...SECOND_FACTOR_CONTRACT,
  ...EMAIL_OTP_CONTRACT,
  ...HANDOFF_CONTRACT,
  ...ORGANIZATIONS_CONTRACT,
  ...ROLES_CONTRACT,
  ...TEAMS_CONTRACT,
  ...TOKENS_CONTRACT,
  ...JWT_CONTRACT,
  ...OPERATOR_CONTRACT,
  ...OAUTH_CONTRACT,
  ...HEALTH_CONTRACT,
  ...SSO_CONTRACT,
  ...SCIM_CONTRACT,
  ...OPENAPI_CONTRACT,
} as const satisfies Record<RouteKey, RouteContract>;

type ContractOf<K extends RouteKey> = (typeof ROUTE_CONTRACT)[K];

/** The JSON answer of a route, as the route writes it; `never` for a page, a redirect, or a metadata document. */
export type AnswerOf<K extends RouteKey> = ContractOf<K>["answer"] extends {
  readonly kind: "json";
  readonly schema: infer S extends z.ZodType;
}
  ? z.output<S>
  : never;

/** The body that a route takes, as a client sends it; `never` for a route with no body. */
export type BodyOf<K extends RouteKey> =
  ContractOf<K> extends {
    readonly body: { readonly schema: infer S extends z.ZodType };
  }
    ? z.input<S>
    : never;

/** The query that a GET takes, as a client sends it; `never` for a route with no query. */
export type QueryOf<K extends RouteKey> =
  ContractOf<K> extends {
    readonly query: { readonly schema: infer S extends z.ZodType };
  }
    ? z.input<S>
    : never;
