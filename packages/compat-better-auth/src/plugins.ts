import {
  type AdminOptions,
  type AdminPlugin,
  type BearerOptions,
  type BearerPlugin,
  COMPAT_PLUGIN,
  type EmailOtpOptions,
  type EmailOtpPlugin,
  type ExpoOptions,
  type ExpoPlugin,
  type MagicLinkOptions,
  type MagicLinkPlugin,
  type OrganizationOptions,
  type OrganizationPlugin,
  type PasskeyOptions,
  type PasskeyPlugin,
  type TwoFactorOptions,
  type TwoFactorPlugin,
} from "./types.js";

// Markers, not behavior: `betterAuth` reads the options (Task 7 checks them,
// Task 8 maps them). The ids are Better Auth's own plugin ids.
export { COMPAT_PLUGIN };

export function organization(options: OrganizationOptions = {}): OrganizationPlugin {
  return { kind: COMPAT_PLUGIN, id: "organization", options };
}
export function passkey(options: PasskeyOptions = {}): PasskeyPlugin {
  return { kind: COMPAT_PLUGIN, id: "passkey", options };
}
export function magicLink(options: MagicLinkOptions): MagicLinkPlugin {
  return { kind: COMPAT_PLUGIN, id: "magic-link", options };
}
export function emailOTP(options: EmailOtpOptions): EmailOtpPlugin {
  return { kind: COMPAT_PLUGIN, id: "email-otp", options };
}
export function bearer(options: BearerOptions = {}): BearerPlugin {
  return { kind: COMPAT_PLUGIN, id: "bearer", options };
}
export function expo(options: ExpoOptions = {}): ExpoPlugin {
  return { kind: COMPAT_PLUGIN, id: "expo", options };
}
export function twoFactor(options: TwoFactorOptions = {}): TwoFactorPlugin {
  return { kind: COMPAT_PLUGIN, id: "two-factor", options };
}
/**
 * Better Auth's admin plugin on core's operator tools (plan 12f, spec
 * section 26 item 14). It needs `organization()` and
 * `authtempo.platformOrganization`.
 */
export function admin(options: AdminOptions = {}): AdminPlugin {
  return { kind: COMPAT_PLUGIN, id: "admin", options };
}
