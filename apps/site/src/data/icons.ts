/** The 16 icons of brand spec 8, in its order, then the three of the theme toggle (brand spec 12). */
export const ICON_NAMES = [
  "start",
  "session",
  "passkey",
  "password",
  "magic-link",
  "otp",
  "second-factor",
  "verify",
  "social",
  "oauth",
  "organization",
  "keyring",
  "limits",
  "routes",
  "client",
  "cli",
  "sun",
  "moon",
  "half-disc",
] as const;
export type IconName = (typeof ICON_NAMES)[number];
