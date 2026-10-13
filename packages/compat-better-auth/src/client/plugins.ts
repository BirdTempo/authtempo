import { type ClientPlugin, COMPAT_CLIENT_PLUGIN } from "../types.js";

type Simple = Extract<
  ClientPlugin,
  { id: "organization" | "passkey" | "magic-link" | "email-otp" }
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
export function emailOTPClient(): Simple {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "email-otp" };
}
