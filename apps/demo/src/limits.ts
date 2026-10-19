import { normalizeEmail } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { DEMO_LIMITS } from "./facts.js";
import { readBodyField, readJsonField } from "./read-body.js";

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
 *   parameters per query and 2 MB per row. Each query here binds at most two values.
 * - Workers limits page, last updated 2026-10-12: a request body of 100 MB
 *   on the Free and Pro Cloudflare plans. The demo cap bodyBytes is 16 KiB.
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

/** SHA-256 in lower-case hex, the hash of a link token in ta_verification (core primitives/crypto.ts:40). */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The address of the live link of `purpose` for a token of the body, or null. */
async function linkAddress(sql: SqlStorage, purpose: string, token: string | null) {
  if (token === null) return null;
  const rows = sql
    .exec<{ identifier: string }>(
      `SELECT identifier FROM ${TABLES.verification} WHERE value_hash = ? AND purpose = ?`,
      await sha256Hex(token),
      purpose,
    )
    .toArray();
  return rows[0]?.identifier ?? null;
}

/**
 * True when the request names a user that exists, so core makes no new
 * user. Each address goes through normalizeEmail of core, as core stores it.
 * A request with no readable address counts as a new user.
 */
async function namesKnownUser(sql: SqlStorage, route: DemoRoute, request: Request) {
  const known = (email: string | null) => {
    const address = email === null ? null : normalizeEmail(email);
    if (address === null) return false;
    const q = `SELECT 1 FROM ${TABLES.user} WHERE email = ?`;
    return sql.exec(q, address).toArray().length > 0;
  };
  switch (route) {
    // Each route reads its body as core reads it, so both read one address (review M1).
    // Core reads these three with readJson (routes/password.ts:69, email-otp.ts:46 and :85).
    case "POST /password/sign-up":
    case "POST /otp/verify":
    case "POST /otp/reset":
      return known(await readJsonField(request, "email"));
    // Core reads these two with readBody (routes/magic-link.ts:68, password.ts:202). It finds
    // each link by the SHA-256 of its token (engine/magic-link.ts:95, password.ts:1043).
    case "POST /magic-link/verify":
      return known(await linkAddress(sql, "magic-link", await readBodyField(request, "token")));
    case "POST /password/reset":
      return known(await linkAddress(sql, "password-reset", await readBodyField(request, "token")));
    case "GET /social/:provider/callback": {
      // The code of the demo provider holds the picked identity (provider.ts).
      const url = new URL(request.url);
      const code = url.searchParams.get("code") ?? "";
      const row = sql
        .exec<{ identity: string }>("SELECT identity FROM demo_provider_code WHERE code = ?", code)
        .toArray()[0];
      if (row === undefined) return false;
      const picked = JSON.parse(row.identity) as { subject: string; email: string };
      const provider = url.pathname.split("/")[3] ?? "";
      const q = `SELECT 1 FROM ${TABLES.identity} WHERE provider = ? AND subject = ?`;
      // A linked identity, or an address that core links to its user.
      return sql.exec(q, provider, picked.subject).toArray().length > 0 || known(picked.email);
    }
    default:
      return false;
  }
}

/**
 * Refuses a route that makes a counted row when its table already holds the
 * limit. A route that makes no counted row always passes. A user route
 * passes for a user that exists, so a sign-in at the cap still works.
 */
export async function checkSandboxLimit(
  sql: SqlStorage,
  route: DemoRoute,
  request: Request,
): Promise<{ ok: true } | { ok: false; limit: string }> {
  const limit = USER_ROUTES.includes(route) ? "usersPerSandbox" : CREATE_ROUTES[route];
  if (limit === undefined) return { ok: true };
  const n = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${COUNTED[limit]}`).one().n;
  if (n < DEMO_LIMITS[limit]) return { ok: true };
  if (limit === "usersPerSandbox" && (await namesKnownUser(sql, route, request)))
    return { ok: true };
  return { ok: false, limit };
}
