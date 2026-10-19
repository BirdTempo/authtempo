import { ipKey } from "@authtempo/core";
import { DEMO_LIMITS, DEMO_PLANNED_ORIGIN, demoDevOrigin } from "@authtempo/demo/facts";

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
  /** The line before the local address. The page shows the address in a code element. */
  thenOpen: "Then open this address in your browser:",
  /** wrangler signs the certificate of a local https run itself. */
  certificate: "The local run has its own certificate, so the browser asks you to accept it.",
  /** The end of the page once the owner sets DEMO_PUBLISHED to true. */
  open: "Open the demo",
  /** The planned host of the demo, from the demo facts (decision 2 of 2026-10-14). */
  host: `${DEMO_PLANNED_ORIGIN}/`,
} as const;

/**
 * The end of the page: a link to the host once the owner sets DEMO_PUBLISHED,
 * else the local command and the address to open (plan 11b, deviation 11).
 * A test reads both values.
 */
export function demoEnd(published: boolean):
  | { kind: "open"; href: string; text: string }
  | {
      kind: "closed";
      text: string;
      command: string;
      thenOpen: string;
      address: string;
      certificate: string;
    } {
  return published
    ? { kind: "open", href: DEMO_PAGE.host, text: DEMO_PAGE.open }
    : {
        kind: "closed",
        text: DEMO_PAGE.notOpen,
        command: DEMO_PAGE.command,
        thenOpen: DEMO_PAGE.thenOpen,
        // The dev script sets DEMO_ORIGIN to this origin (final review M1).
        address: `${demoDevOrigin()}/`,
        certificate: DEMO_PAGE.certificate,
      };
}

/**
 * The IPv6 prefix length that one per-IP count of core covers. Core ipKey
 * writes it at the end of the key of an IPv6 address ("2001:db8:1:2::/64"),
 * so the page reads it from core at build time and types no number.
 */
export function ipv6Prefix(key: (ip: string) => string = ipKey): number {
  const m = /\/(\d+)$/.exec(key("2001:db8:1:2:3:4:5:6"));
  if (m === null) throw new Error("demo.ts: core ipKey gives no prefix for an IPv6 address");
  return Number(m[1]);
}

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
    `${n} new sandboxes per address per ${windowWords(DEMO_LIMITS.windowMs)}. An IPv6 address counts by its /${ipv6Prefix()}.`,
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
