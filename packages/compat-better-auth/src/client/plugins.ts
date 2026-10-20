import {
  type ClientPlugin,
  COMPAT_CLIENT_PLUGIN,
  type OrganizationClientOptions,
  type TwoFactorClientOptions,
} from "../types.js";

type Simple = Extract<ClientPlugin, { id: "passkey" | "magic-link" | "email-otp" | "admin" }>;

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
