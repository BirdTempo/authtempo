import type { RouteFeature } from "@authtempo/core/routes";

/** What the demo turns on. coverage.test.ts holds it to ROUTES both ways. */
export const DEMO_FEATURES = [
  "session",
  // account and accountDelete are on in every deployment of core (plan 12a, ruling 33 of the lane).
  "account",
  "accountDelete",
  "magicLink",
  "social",
  "passkey",
  "password",
  "totp",
  "emailOtp",
  "emailOtpReset",
  "organizations",
  "tokens",
] as const satisfies readonly RouteFeature[];

/** Off in the demo, each with its reason. A new feature of core fails the coverage test until it is in one list. */
export const DEMO_EXEMPT = {
  handoff: "It needs a native or desktop app on the visitor's device.",
  oauth: "The provider needs a client app. A later row can add a demo client page.",
  oauthRegistration: "The provider needs a client app.",
  jwtMint: "Its key set and tokens serve a client app, which the demo does not have.",
  operator: "An operator tool, not a sign-in method.",
  // Ruling 33 of the lane: the owner may move it later.
  openapi: "A machine document of the routes, not a sign-in method; the docs serve it.",
} as const satisfies Partial<Record<RouteFeature, string>>;

/** The owner sets this to true at publication (plan 11b, deviation 11). */
export const DEMO_PUBLISHED = false;
