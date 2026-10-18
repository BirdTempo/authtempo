import type { ErrorCode } from "../errors.js";

/**
 * Every route that core can serve, with the config that turns it on (plan
 * 11a). The docs routes page has one anchor for each entry, and its check
 * reads this list. `route-list.test.ts` proves that the router serves exactly
 * this list when every feature is on, so the list cannot drift from the
 * route files. A path is relative to `basePath`. `:provider` stands for each
 * configured social provider; Apple's callback is the one POST callback.
 */
export type RouteFeature =
  | "session"
  | "account"
  | "accountDelete"
  | "magicLink"
  | "social"
  | "passkey"
  | "password"
  | "totp"
  | "emailOtp"
  | "emailOtpReset"
  | "handoff"
  | "organizations"
  | "tokens"
  | "jwtMint"
  | "operator"
  | "oauth"
  | "oauthRegistration";

export interface RouteEntry {
  readonly method: "GET" | "POST";
  readonly path: string;
  /**
   * The config that turns the route on. `session`, `magicLink`, and `tokens`
   * are in every deployment; `emailOtp` and `jwtMint` are on by default;
   * `emailOtpReset` needs `emailOtp` and `password`; `totp` needs `password`;
   * `oauthRegistration` needs `oauth` with `registration.dynamic`; `operator`
   * needs `operator.secretHash` (plan 11c), and `/operator/keys/rotate` also
   * needs `jwtMint` (plan 11c2). `account` (plan 12a) is in every
   * deployment. `accountDelete` (plan 12a) is on by default; `account.delete:
   * false` turns it off.
   */
  readonly feature: RouteFeature;
}

// No annotation on the constant: the type stays the literal tuple, so an SDK's path is checked at compile time (plan 11d).
export const ROUTES = Object.freeze([
  { method: "GET", path: "/session", feature: "session" },
  { method: "POST", path: "/session/refresh", feature: "session" },
  { method: "POST", path: "/sign-out", feature: "session" },
  { method: "POST", path: "/reauth", feature: "account" },
  { method: "POST", path: "/reauth/passkey/options", feature: "passkey" },
  { method: "POST", path: "/reauth/email", feature: "emailOtp" },
  { method: "GET", path: "/sessions", feature: "account" },
  { method: "POST", path: "/sessions/revoke", feature: "account" },
  { method: "POST", path: "/sessions/revoke-others", feature: "account" },
  { method: "POST", path: "/user/update", feature: "account" },
  { method: "POST", path: "/user/change-email", feature: "account" },
  { method: "GET", path: "/user/change-email/confirm", feature: "account" },
  { method: "POST", path: "/user/change-email/confirm", feature: "account" },
  { method: "POST", path: "/user/change-email/verify", feature: "emailOtp" },
  { method: "POST", path: "/user/delete", feature: "accountDelete" },
  { method: "GET", path: "/user/delete/confirm", feature: "accountDelete" },
  { method: "POST", path: "/user/delete/confirm", feature: "accountDelete" },
  { method: "GET", path: "/identities", feature: "account" },
  { method: "POST", path: "/identities/unlink", feature: "account" },
  { method: "POST", path: "/magic-link/request", feature: "magicLink" },
  { method: "GET", path: "/magic-link/verify", feature: "magicLink" },
  { method: "POST", path: "/magic-link/verify", feature: "magicLink" },
  { method: "GET", path: "/social/:provider/start", feature: "social" },
  { method: "POST", path: "/social/:provider/link", feature: "social" },
  { method: "GET", path: "/social/:provider/callback", feature: "social" },
  { method: "POST", path: "/social/apple/callback", feature: "social" },
  { method: "POST", path: "/passkey/register/options", feature: "passkey" },
  { method: "POST", path: "/passkey/register/verify", feature: "passkey" },
  { method: "POST", path: "/passkey/authenticate/options", feature: "passkey" },
  { method: "POST", path: "/passkey/authenticate/verify", feature: "passkey" },
  { method: "GET", path: "/passkeys", feature: "passkey" },
  { method: "POST", path: "/passkeys/delete", feature: "passkey" },
  { method: "POST", path: "/passkeys/rename", feature: "passkey" },
  { method: "POST", path: "/password/sign-up", feature: "password" },
  { method: "POST", path: "/password/sign-in", feature: "password" },
  { method: "GET", path: "/password/verify", feature: "password" },
  { method: "POST", path: "/password/verify", feature: "password" },
  { method: "POST", path: "/password/verify/resend", feature: "password" },
  { method: "POST", path: "/password/reset/request", feature: "password" },
  { method: "GET", path: "/password/reset", feature: "password" },
  { method: "POST", path: "/password/reset", feature: "password" },
  { method: "POST", path: "/password/change", feature: "password" },
  { method: "POST", path: "/totp/setup", feature: "totp" },
  { method: "POST", path: "/totp/enable", feature: "totp" },
  { method: "POST", path: "/totp/disable", feature: "totp" },
  { method: "POST", path: "/totp/backup-codes", feature: "totp" },
  { method: "GET", path: "/totp", feature: "totp" },
  { method: "POST", path: "/totp/devices/revoke", feature: "totp" },
  { method: "POST", path: "/totp/verify", feature: "totp" },
  { method: "GET", path: "/totp/challenge", feature: "totp" },
  { method: "POST", path: "/totp/challenge", feature: "totp" },
  // Plan 12c: the second-factor methods. Mounted with `totp`; a passkey route
  // answers not_found without the `passkey` config.
  { method: "POST", path: "/second-factor/passkey/enable", feature: "totp" },
  { method: "POST", path: "/second-factor/passkey/options", feature: "totp" },
  { method: "POST", path: "/second-factor/disable", feature: "totp" },
  { method: "POST", path: "/second-factor/email/enable", feature: "totp" },
  { method: "POST", path: "/second-factor/email/send", feature: "totp" },
  { method: "POST", path: "/otp/request", feature: "emailOtp" },
  { method: "POST", path: "/otp/verify", feature: "emailOtp" },
  { method: "POST", path: "/otp/reset/request", feature: "emailOtpReset" },
  { method: "POST", path: "/otp/reset", feature: "emailOtpReset" },
  { method: "GET", path: "/handoff/start", feature: "handoff" },
  { method: "GET", path: "/handoff/continue", feature: "handoff" },
  { method: "POST", path: "/handoff/continue", feature: "handoff" },
  { method: "POST", path: "/handoff/redeem", feature: "handoff" },
  { method: "POST", path: "/organizations/create", feature: "organizations" },
  { method: "GET", path: "/organizations", feature: "organizations" },
  { method: "POST", path: "/organizations/update", feature: "organizations" },
  { method: "POST", path: "/organizations/delete", feature: "organizations" },
  { method: "GET", path: "/organizations/members", feature: "organizations" },
  { method: "POST", path: "/organizations/members/add", feature: "organizations" },
  { method: "POST", path: "/organizations/members/role", feature: "organizations" },
  { method: "POST", path: "/organizations/members/remove", feature: "organizations" },
  { method: "POST", path: "/organizations/invite", feature: "organizations" },
  { method: "GET", path: "/organizations/invitations", feature: "organizations" },
  { method: "POST", path: "/organizations/invitations/revoke", feature: "organizations" },
  { method: "POST", path: "/organizations/invitations/accept", feature: "organizations" },
  { method: "POST", path: "/organizations/invitations/decline", feature: "organizations" },
  { method: "POST", path: "/organizations/active", feature: "organizations" },
  { method: "POST", path: "/tokens", feature: "tokens" },
  { method: "GET", path: "/tokens", feature: "tokens" },
  { method: "POST", path: "/tokens/revoke", feature: "tokens" },
  { method: "GET", path: "/tokens/current", feature: "tokens" },
  { method: "GET", path: "/jwks", feature: "jwtMint" },
  { method: "GET", path: "/token", feature: "jwtMint" },
  { method: "POST", path: "/token/live", feature: "jwtMint" },
  { method: "POST", path: "/operator/keys/rotate", feature: "operator" },
  { method: "GET", path: "/operator/secrets/status", feature: "operator" },
  { method: "POST", path: "/operator/secrets/rewrap", feature: "operator" },
  { method: "GET", path: "/operator/info", feature: "operator" },
  { method: "POST", path: "/oauth/register", feature: "oauthRegistration" },
  { method: "GET", path: "/oauth/authorize", feature: "oauth" },
  { method: "POST", path: "/oauth/authorize", feature: "oauth" },
  { method: "GET", path: "/oauth/sign-in", feature: "oauth" },
  { method: "POST", path: "/oauth/token", feature: "oauth" },
  { method: "POST", path: "/oauth/revoke", feature: "oauth" },
  { method: "GET", path: "/oauth/userinfo", feature: "oauth" },
  { method: "POST", path: "/oauth/userinfo", feature: "oauth" },
  { method: "GET", path: "/oauth/grants", feature: "oauth" },
  { method: "POST", path: "/oauth/grants/revoke", feature: "oauth" },
  { method: "GET", path: "/.well-known/oauth-authorization-server", feature: "oauth" },
  { method: "GET", path: "/.well-known/openid-configuration", feature: "oauth" },
] as const satisfies readonly RouteEntry[]);

/** The method of a route. */
export type RouteMethod = RouteEntry["method"];

/** One entry of `ROUTES` with its literal method and path (plan 11d). */
export type RouteLiteral = (typeof ROUTES)[number];

/**
 * A path that `ROUTES` holds for the method `M` (plan 11d). An SDK types its
 * paths with it, so a path that core does not serve fails the SDK's compile.
 */
export type RoutePath<M extends RouteMethod = RouteMethod> = Extract<
  RouteLiteral,
  { method: M }
>["path"];

/**
 * The codes that the router answers for every route (plan 11g): `not_found`
 * for a feature that is off, `origin_not_trusted` for a POST from an origin
 * that is not trusted, and `internal` for an unhandled error. An entry does
 * not repeat them; the OpenAPI document adds them to each operation.
 */
export const ROUTER_CODES = [
  "not_found",
  "origin_not_trusted",
  "internal",
] as const satisfies readonly ErrorCode[];
export type RouterCode = (typeof ROUTER_CODES)[number];
