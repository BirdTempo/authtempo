/**
 * The call limits of `authtempo secret rewrap` (plan 11c2). One module with
 * no import, so the help and the command read the same numbers.
 */

/**
 * The most calls of one run, by default. At the default limit of 100 rows
 * a call, 100 calls move 10 000 rows. The limiter of core allows 120 calls
 * an hour.
 */
export const DEFAULT_MAX_CALLS = 100;

/** The most calls that `--max-calls` takes. */
export const MAX_CALLS_MAX = 10_000;

/**
 * The limit of the three routes of plan 11c2: 120 calls per IP per hour. A
 * copy of `OPERATOR_SECRETS_PER_IP.max` in core's `src/http/routes/operator.ts`
 * (read 2026-10-19), because no entry of core that the CLI reads exports it.
 * The number is in a stop text and in the rewrap help only.
 */
export const CALLS_PER_HOUR = 120;
