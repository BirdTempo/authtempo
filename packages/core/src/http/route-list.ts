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
  | "oauth"
  | "oauthRegistration";

export interface RouteEntry {
  readonly method: "GET" | "POST";
  readonly path: string;
  /**
   * The config that turns the route on. `session`, `magicLink`, and `tokens`
   * are in every deployment; `emailOtp` and `jwtMint` are on by default;
   * `emailOtpReset` needs `emailOtp` and `password`; `totp` needs `password`;
   * `oauthRegistration` needs `oauth` with `registration.dynamic`.
   */
  readonly feature: RouteFeature;
}

export const ROUTES: readonly RouteEntry[] = Object.freeze([
  { method: "GET", path: "/session", feature: "session" },
  { method: "POST", path: "/sign-out", feature: "session" },
  { method: "POST", path: "/magic-link/request", feature: "magicLink" },
  { method: "GET", path: "/magic-link/verify", feature: "magicLink" },
  { method: "POST", path: "/magic-link/verify", feature: "magicLink" },
  { method: "GET", path: "/social/:provider/start", feature: "social" },
  { method: "GET", path: "/social/:provider/callback", feature: "social" },
  { method: "POST", path: "/social/apple/callback", feature: "social" },
  { method: "POST", path: "/passkey/register/options", feature: "passkey" },
  { method: "POST", path: "/passkey/register/verify", feature: "passkey" },
  { method: "POST", path: "/passkey/authenticate/options", feature: "passkey" },
  { method: "POST", path: "/passkey/authenticate/verify", feature: "passkey" },
  { method: "GET", path: "/passkeys", feature: "passkey" },
  { method: "POST", path: "/passkeys/delete", feature: "passkey" },
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
