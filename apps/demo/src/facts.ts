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
  oauthDevice: "The device grant needs a client app on a device, and the demo has none.",
  jwtMint: "Its key set and tokens serve a client app, which the demo does not have.",
  operator: "An operator tool, not a sign-in method.",
  operatorUsers: "An operator tool, not a sign-in method.",
  operatorImpersonation: "An operator tool, not a sign-in method.",
  // Ruling 33 of the lane: the owner may move it later.
  openapi: "A machine document of the routes, not a sign-in method; the docs serve it.",
} as const satisfies Partial<Record<RouteFeature, string>>;

/**
 * Where a part that the demo turns off would live. "config" is a key path of
 * the core config that demoConfig leaves unset. "cron" is a scheduled handler
 * of the Worker. "package" is a workspace package that the demo does not depend on.
 */
export type DemoOffPlace =
  | { kind: "config"; path: string }
  | { kind: "cron" }
  | { kind: "package"; name: string };

/**
 * The parts of authtempo that the design turns off in the demo, each with its
 * reason (plan 11b design, "Turned off in the demo"). No one of them is a
 * route feature. The tests test/off.test.ts and test/node/off.test.ts hold
 * each place (final review m3). So a part that the demo turns on fails a test.
 */
export const DEMO_OFF: readonly { name: string; reason: string; place: DemoOffPlace }[] = [
  {
    name: "The breach check",
    reason: "It calls a service of another company, and the demo sends no request out.",
    place: { kind: "config", path: "password.breachCheck" },
  },
  {
    name: "The captcha",
    reason: "A real Turnstile key is a key of a real provider, and the demo holds no secret.",
    place: { kind: "config", path: "captcha" },
  },
  {
    name: "The hooks",
    reason: "A hook runs the code of an app, and the demo has no app code.",
    place: { kind: "config", path: "hooks" },
  },
  {
    name: "The sweep",
    reason: "The alarm of each sandbox deletes its whole store, so no sweep is necessary.",
    // An app runs auth.sweepExpired() from a scheduled handler.
    place: { kind: "cron" },
  },
  {
    name: "The Better Auth compatibility instance",
    reason: "It serves an app that moves from Better Auth, and the demo has no such app.",
    place: { kind: "package", name: "@authtempo/compat-better-auth" },
  },
];

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
  /**
   * Requests per IP per minute in one isolate, counted before any Durable
   * Object call (src/flood.ts). A person who clicks through the demo sends far
   * fewer. Weak: each isolate counts alone (final review m7).
   */
  requestsPerIpPerMinute: 600,
} as const;

/** The two limits that the gate checks, by their keys of DEMO_LIMITS. */
export type GateLimit = Extract<keyof typeof DEMO_LIMITS, "sandboxesPerIp" | "sandboxesTotal">;
