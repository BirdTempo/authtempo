import {
  type BearerOptions,
  type BearerPlugin,
  COMPAT_PLUGIN,
  type ExpoOptions,
  type ExpoPlugin,
  type MagicLinkOptions,
  type MagicLinkPlugin,
  type OrganizationOptions,
  type OrganizationPlugin,
  type PasskeyOptions,
  type PasskeyPlugin,
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
export function bearer(options: BearerOptions = {}): BearerPlugin {
  return { kind: COMPAT_PLUGIN, id: "bearer", options };
}
export function expo(options: ExpoOptions = {}): ExpoPlugin {
  return { kind: COMPAT_PLUGIN, id: "expo", options };
}
