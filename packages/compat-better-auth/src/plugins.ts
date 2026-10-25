import {
  type AdminOptions,
  type AdminPlugin,
  type AnonymousOptions,
  type AnonymousPlugin,
  type BearerOptions,
  type BearerPlugin,
  COMPAT_PLUGIN,
  type EmailOtpOptions,
  type EmailOtpPlugin,
  type ExpoOptions,
  type ExpoPlugin,
  type LastLoginMethodOptions,
  type LastLoginMethodPlugin,
  type MagicLinkOptions,
  type MagicLinkPlugin,
  type MultiSessionOptions,
  type MultiSessionPlugin,
  type OneTapOptions,
  type OneTapPlugin,
  type OrganizationOptions,
  type OrganizationPlugin,
  type PasskeyOptions,
  type PasskeyPlugin,
  type PhoneNumberOptions,
  type PhoneNumberPlugin,
  type TwoFactorOptions,
  type TwoFactorPlugin,
  type UsernameOptions,
  type UsernamePlugin,
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

// The sign-in plugins of plan 12i Task 16. Each maps onto one core feature;
// check-options.ts refuses each option that core cannot keep.

/** Core's anonymous sign-in. Needs a shared limiter: the daily cap is per deployment. */
export function anonymous(options: AnonymousOptions = {}): AnonymousPlugin {
  return { kind: COMPAT_PLUGIN, id: "anonymous", options };
}
/** Core's username, with the sign-in by username on core's password route. */
export function username(options: UsernameOptions = {}): UsernamePlugin {
  return { kind: COMPAT_PLUGIN, id: "username", options };
}
/** Core's phone code. `sendOTP` delivers each code that core makes; it needs `authtempo.phone.regions`. */
export function phoneNumber(options: PhoneNumberOptions): PhoneNumberPlugin {
  return { kind: COMPAT_PLUGIN, id: "phone-number", options };
}
/** Core's ID-token route for `google`, with no nonce, as Better Auth's One Tap. */
export function oneTap(options: OneTapOptions = {}): OneTapPlugin {
  return { kind: COMPAT_PLUGIN, id: "one-tap", options };
}
/** Core's multi-session. */
export function multiSession(options: MultiSessionOptions = {}): MultiSessionPlugin {
  return { kind: COMPAT_PLUGIN, id: "multi-session", options };
}
/** Core's last method cookie. */
export function lastLoginMethod(options: LastLoginMethodOptions = {}): LastLoginMethodPlugin {
  return { kind: COMPAT_PLUGIN, id: "last-login-method", options };
}
