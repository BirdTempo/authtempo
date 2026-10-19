import type { RouteFeature } from "@authtempo/core/routes";
import type { IconName } from "./icons.ts";

/** One feature row of the home page (brand spec 9). Plan 11b Task 4 adds `guide`. */
export interface Feature {
  title: string;
  line: string;
  icon: IconName;
}

/**
 * One row per member of RouteFeature (17 at 0ef9665). A Record over the union
 * fails the site's typecheck when core adds a member, so a new feature cannot
 * ship without its row. Each line restates the description of its guide.
 * The sprite has no symbol for `account` or `accountDelete` (spec 8 names 16
 * icons, and decision 3 keeps the list). `account` takes `verify`: its first
 * route is the re-authentication, and the guide says "prove it again".
 * `accountDelete` takes `magic-link`: the delete mails a link whose page
 * deletes the account, and a notice goes to the deleted address. The next row,
 * `magicLink`, also shows the envelope. We accept the repeat, because the
 * mailed link is the only visible step of the delete. No symbol of spec 8
 * means a removal, and spec 9 sets no rule against a repeat. The two oauth
 * rows also repeat.
 */
export const FEATURES: Readonly<Record<RouteFeature, Feature>> = {
  session: {
    title: "Sessions",
    line: "A session cookie or a bearer token, checked on each request.",
    icon: "session",
  },
  account: {
    title: "Account settings",
    line: "See and end sessions, prove it again, and change the profile.",
    icon: "verify",
  },
  accountDelete: {
    title: "Account deletion",
    line: "Delete the account, with a mailed link when the option is on.",
    icon: "magic-link",
  },
  magicLink: {
    title: "Magic links",
    line: "A single-use link by mail opens a session.",
    icon: "magic-link",
  },
  social: {
    title: "Social sign-in",
    line: "Sign in with Google, Apple, GitHub, LinkedIn, or an OIDC provider.",
    icon: "social",
  },
  passkey: {
    title: "Passkeys",
    line: "Register a passkey, and sign in with a discoverable passkey.",
    icon: "passkey",
  },
  password: {
    title: "Passwords",
    line: "Sign-up, sign-in, mail verification, reset, and change with a password.",
    icon: "password",
  },
  totp: {
    title: "Second factor",
    line: "Finish a sign-in with TOTP, a passkey, or an email code.",
    icon: "second-factor",
  },
  emailOtp: {
    title: "Email codes",
    line: "A 6 or 8 digit code by mail signs a person in.",
    icon: "otp",
  },
  emailOtpReset: {
    title: "Reset by code",
    line: "A code by mail resets a forgotten password.",
    icon: "otp",
  },
  handoff: {
    title: "Native apps",
    line: "Sign in from Expo or Electron through the system browser.",
    icon: "client",
  },
  organizations: {
    title: "Organizations",
    line: "Organizations, ranked roles, mailed invitations, and the active organization.",
    icon: "organization",
  },
  tokens: {
    title: "API tokens",
    line: "A script or a CLI calls your routes with an API token.",
    icon: "keyring",
  },
  jwtMint: {
    title: "Session JWTs",
    line: "A short JWT that another server checks against your key set.",
    icon: "verify",
  },
  operator: {
    title: "Operator routes",
    line: "Rotate the signing keys with a hashed operator secret.",
    icon: "cli",
  },
  oauth: {
    title: "OAuth provider",
    line: "Agents and MCP clients get access tokens with consent and PKCE.",
    icon: "oauth",
  },
  oauthRegistration: {
    title: "Client registration",
    line: "An MCP client registers itself when you turn the option on.",
    icon: "oauth",
  },
};

/** The members of RouteFeature in the order of their first route. */
export function featureOrder(routes: readonly { feature: RouteFeature }[]): RouteFeature[] {
  const out: RouteFeature[] = [];
  for (const r of routes) if (!out.includes(r.feature)) out.push(r.feature);
  return out;
}
