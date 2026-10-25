import {
  type ClientPlugin,
  COMPAT_CLIENT_PLUGIN,
  type OrganizationClientOptions,
  type TwoFactorClientOptions,
} from "../types.js";

type Simple = Extract<
  ClientPlugin,
  {
    id:
      | "passkey"
      | "magic-link"
      | "email-otp"
      | "admin"
      | "api-key"
      | "sso"
      | "anonymous"
      | "username"
      | "phone-number"
      | "multi-session";
  }
>;

/** Better Auth's `organizationClient({ ac, roles })`: `checkRolePermission` reads the roles (plan 12k). */
export function organizationClient(
  options?: OrganizationClientOptions,
): Extract<ClientPlugin, { id: "organization" }> {
  return options
    ? { kind: COMPAT_CLIENT_PLUGIN, id: "organization", options }
    : { kind: COMPAT_CLIENT_PLUGIN, id: "organization" };
}
export function passkeyClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "passkey" };
}
export function magicLinkClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "magic-link" };
}
/**
 * Better Auth's `adminClient()` (plan 12f): the session read goes to the
 * shim's `/get-session`, so the user holds the role and the ban fields.
 */
export function adminClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "admin" };
}
export function emailOTPClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "email-otp" };
}
export function twoFactorClient(
  options: TwoFactorClientOptions = {},
): Extract<ClientPlugin, { id: "two-factor" }> {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "two-factor", options };
}
/** Better Auth's `apiKeyClient()` (plan 12k Task 12). `authClient.apiKey` is there with or without it. */
export function apiKeyClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "api-key" };
}
/**
 * Better Auth's `ssoClient()` of @better-auth/sso 1.7.2 (plan 12d Task 14).
 * `authClient.sso` and `authClient.signIn.sso` are there with or without it.
 */
export function ssoClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "sso" };
}

// The client plugins of plan 12i Task 16. Their calls are on the client with
// or without them, and the server answers 404 for a plugin that is off.
export function anonymousClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "anonymous" };
}
export function usernameClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "username" };
}
export function phoneNumberClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "phone-number" };
}
export function multiSessionClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "multi-session" };
}
/** Better Auth's `lastLoginMethodClient({ cookieName })`: the name of the server plugin's cookie. */
export function lastLoginMethodClient(options?: {
  cookieName?: string;
}): Extract<ClientPlugin, { id: "last-login-method" }> {
  return options
    ? { kind: COMPAT_CLIENT_PLUGIN, id: "last-login-method", options }
    : { kind: COMPAT_CLIENT_PLUGIN, id: "last-login-method" };
}
