import { DEMO_LIMITS } from "@authtempo/demo/facts";

/**
 * The parts of /demo/ outside its entry (plan 11b Task 12). Every number comes
 * from DEMO_LIMITS of @authtempo/demo/facts at build time. check-terms and
 * check-sentences read each string through scripts/lib/demo-prose.ts.
 */
export const DEMO_PAGE = {
  /** The end of the page while DEMO_PUBLISHED is false (plan 11b, deviation 11). */
  notOpen: "The hosted demo is not open yet. Run it on your machine:",
  /** The local command of the demo. The page shows it in a code element. */
  command: "pnpm --filter @authtempo/demo dev",
  /** The end of the page once the owner sets DEMO_PUBLISHED to true. */
  open: "Open the demo",
  /** The planned host of the demo (decision 2 of 2026-10-14). */
  host: "https://demo.authtempo.com/",
} as const;

/**
 * The parts of authtempo that the design turns off in the demo, each with its
 * reason (plan 11b design, "Turned off in the demo"). No one of them is a
 * route feature.
 */
export const DEMO_OFF: readonly { name: string; reason: string }[] = [
  {
    name: "The breach check",
    reason: "It calls a service of another company, and the demo sends no request out.",
  },
  {
    name: "The captcha",
    reason: "A real Turnstile key is a key of a real provider, and the demo holds no secret.",
  },
  { name: "The hooks", reason: "A hook runs the code of an app, and the demo has no app code." },
  {
    name: "The sweep",
    reason: "The alarm of each sandbox deletes its whole store, so no sweep is necessary.",
  },
  {
    name: "The Better Auth compatibility instance",
    reason: "It serves an app that moves from Better Auth, and the demo has no such app.",
  },
];

/** The minutes of a span in milliseconds. */
function minutes(ms: number): number {
  return ms / 60_000;
}

/** The gate window in words: "hour" for 60 minutes, else the minutes. */
function windowWords(ms: number): string {
  return ms === 3_600_000 ? "hour" : `${minutes(ms)} minutes`;
}

/**
 * Each limit of the demo in words, with its number from DEMO_LIMITS. The type
 * needs a row for each key, so a new limit stops the build until it has words.
 */
export const LIMIT_WORDS: { readonly [K in keyof typeof DEMO_LIMITS]: (n: number) => string } = {
  sandboxesPerIp: (n) =>
    `${n} new sandboxes per address per ${windowWords(DEMO_LIMITS.windowMs)}. An IPv6 address counts by its /64.`,
  sandboxesTotal: (n) => `${n} new sandboxes in total per ${windowWords(DEMO_LIMITS.windowMs)}.`,
  windowMs: (n) => `The gate deletes each address ${minutes(n)} minutes after its visit.`,
  sandboxLifeMs: (n) => `The demo deletes each sandbox ${minutes(n)} minutes after it starts.`,
  usersPerSandbox: (n) => `${n} users per sandbox.`,
  passkeysPerSandbox: (n) => `${n} passkeys per sandbox.`,
  tokensPerSandbox: (n) => `${n} API tokens per sandbox.`,
  organizationsPerSandbox: (n) => `${n} organizations per sandbox.`,
  mailsKept: (n) => `The mailbox keeps the newest ${n} mails.`,
  bodyBytes: (n) => `A request body of at most ${n} bytes.`,
};

/** One row per key of DEMO_LIMITS, in the order of the object, with its words. */
export function limitRows(): { key: keyof typeof DEMO_LIMITS; text: string }[] {
  return (Object.keys(DEMO_LIMITS) as (keyof typeof DEMO_LIMITS)[]).map((key) => ({
    key,
    text: LIMIT_WORDS[key](DEMO_LIMITS[key]),
  }));
}
