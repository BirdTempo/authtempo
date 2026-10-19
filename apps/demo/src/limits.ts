import { TABLES } from "@authtempo/core/sql";
import { DEMO_LIMITS } from "./facts.js";

/*
 * The limits of one sandbox. Each count is a count of rows in the store of
 * the sandbox, read before core runs, so a refusal changes nothing. The gate
 * limits (sandboxesPerIp, sandboxesTotal, windowMs) are in gate.ts.
 *
 * The platform limits that these numbers stay under (read 2026-10-20):
 * - Durable Objects limits page, last updated 2026-06-01: 5 GB of SQLite
 *   storage per account on Workers Free. 600 sandboxes an hour, each with at
 *   most 10 rows of each counted table and 50 mails, stay far below it.
 * - Durable Objects limits page, last updated 2026-06-01: 100 bound
 *   parameters per query and 2 MB per row. No query here binds a value.
 * - Workers limits page, last updated 2026-10-12: a request body of 100 MB
 *   on the Free plan. The demo cap bodyBytes is 16 KiB.
 * - Workers limits page, last updated 2026-10-12: 100,000 requests a day on
 *   Workers Free. The gate total holds the new sandboxes; the WAF rate rule
 *   at publication is an owner-run item and helps only.
 */

/** A route as "<METHOD> <path under /auth>", with :provider for a provider name. */
export type DemoRoute = string;

/**
 * The routes of DEMO_FEATURES that can make a user. Each line names the
 * create of core that the route reaches (packages/core/src at 2c51a37).
 */
export const USER_ROUTES: readonly DemoRoute[] = [
  // engine/password.ts:340 (insertSignUp) and :478 (insertUniform).
  "POST /password/sign-up",
  // engine/magic-link.ts:125 calls findOrCreateUserByEmail, engine/users.ts:429.
  "POST /magic-link/verify",
  // engine/email-otp.ts:348 calls findOrCreateUserByEmail, engine/users.ts:429.
  "POST /otp/verify",
  // engine/social.ts:861. The POST callback of Apple is not mounted: the demo has no Apple provider.
  "GET /social/:provider/callback",
  // engine/password.ts:1311 (applyReset): a reset link to an address with no user makes the user.
  "POST /password/reset",
  // engine/email-otp.ts:414 calls resetWithProof, which reaches engine/password.ts:1311.
  "POST /otp/reset",
];

type CountedLimit =
  | "usersPerSandbox"
  | "passkeysPerSandbox"
  | "tokensPerSandbox"
  | "organizationsPerSandbox";

/** The routes that make one row of a counted table, with the limit of that table. */
export const CREATE_ROUTES: Readonly<Record<DemoRoute, CountedLimit>> = {
  "POST /passkey/register/verify": "passkeysPerSandbox",
  "POST /tokens": "tokensPerSandbox",
  "POST /organizations/create": "organizationsPerSandbox",
};

/** The table that each limit counts, by the table names of core (TABLES). */
const COUNTED: Readonly<Record<CountedLimit, string>> = {
  usersPerSandbox: TABLES.user,
  passkeysPerSandbox: TABLES.passkey,
  tokensPerSandbox: TABLES.apiToken,
  organizationsPerSandbox: TABLES.organization,
};

const SOCIAL_CALLBACK_RE = /^\/social\/[^/]+\/callback$/;

/** The route of a request to core, or null outside /auth. */
export function routeOf(method: string, pathname: string): DemoRoute | null {
  if (!pathname.startsWith("/auth/")) return null;
  const path = pathname.slice("/auth".length);
  const shape = SOCIAL_CALLBACK_RE.test(path) ? "/social/:provider/callback" : path;
  return `${method} ${shape}`;
}

/**
 * Refuses a route that makes a counted row when its table already holds the
 * limit. A route that makes no counted row always passes.
 */
export function checkSandboxLimit(
  sql: SqlStorage,
  route: DemoRoute,
): { ok: true } | { ok: false; limit: string } {
  const limit = USER_ROUTES.includes(route) ? "usersPerSandbox" : CREATE_ROUTES[route];
  if (limit === undefined) return { ok: true };
  const n = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${COUNTED[limit]}`).one().n;
  return n >= DEMO_LIMITS[limit] ? { ok: false, limit } : { ok: true };
}
