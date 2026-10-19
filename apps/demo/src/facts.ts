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
  oauth: "The provider needs a client app, and the demo has none.",
  oauthRegistration: "The provider needs a client app.",
  jwtMint: "Its key set and tokens serve a client app, which the demo does not have.",
  operator: "An operator tool, not a sign-in method.",
  // Ruling 33 of the lane: the owner may move it later.
  openapi: "A machine document of the routes, not a sign-in method; the docs serve it.",
} as const satisfies Partial<Record<RouteFeature, string>>;

/** The owner sets this to true at publication (plan 11b, deviation 11). */
export const DEMO_PUBLISHED = false;

/**
 * The planned origin of the hosted demo (decision 2 of 2026-10-14). The var
 * DEMO_ORIGIN of wrangler.jsonc has this value, and a Node test holds the two equal.
 */
export const DEMO_PLANNED_ORIGIN = "https://demo.authtempo.com";

/** The port of the local demo. scripts/dev.mjs listens on it unless DEMO_PORT names another. */
export const DEMO_DEV_PORT = 8787;

/**
 * The origin of the local demo on `port`. The dev script passes it as
 * DEMO_ORIGIN, so core trusts the page origin. Each mail link and each
 * provider URL then names this origin, not the planned host.
 */
export function demoDevOrigin(port: number = DEMO_DEV_PORT): string {
  return `https://localhost:${port}`;
}

/**
 * The docs base of the site. Each demo page links its guide under it. A site
 * test holds it to the origin of the site, so the two cannot drift.
 */
export const DOCS_BASE = "https://authtempo.com/docs";

/**
 * Every limit of the demo, in one place, each with its reason. Code of the
 * demo enforces each one, and no Cloudflare setting holds a limit alone.
 * gate.ts checks the gate limits, and limits.ts checks the sandbox limits.
 */
export const DEMO_LIMITS = {
  /** New sandboxes per IP per hour. The gate counts the rows of its admit table with this ip (an IPv6 address by its /64). One visitor rarely needs more than one. */
  sandboxesPerIp: 5,
  /** New sandboxes in total per hour. The gate counts all rows of its admit table. Holds the platform cost of the demo. */
  sandboxesTotal: 600,
  /** The window of both gate counts. The gate also deletes each IP at its end (spec 24 item 11). */
  windowMs: 3_600_000,
  /** The life of a sandbox from its creation. No extension on use. */
  sandboxLifeMs: 3_600_000,
  /** Users in one sandbox, through each route that can make a user (USER_ROUTES). */
  usersPerSandbox: 10,
  passkeysPerSandbox: 10,
  tokensPerSandbox: 10,
  organizationsPerSandbox: 10,
  /** The mailbox keeps the newest mails of a sandbox only. */
  mailsKept: 50,
  /** A body above this answers 413 before the parse. The largest demo form is under 2 KiB. */
  bodyBytes: 16_384,
} as const;
