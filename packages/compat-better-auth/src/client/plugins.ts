import { type ClientPlugin, COMPAT_CLIENT_PLUGIN, type TwoFactorClientOptions } from "../types.js";

type Simple = Extract<
  ClientPlugin,
  { id: "organization" | "passkey" | "magic-link" | "email-otp" | "admin" }
>;

export function organizationClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "organization" };
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
