import { OPERATOR_SECRETS_PER_IP } from "@authtempo/core/operator-secret";

/**
 * The call limits of `authtempo secret rewrap` (plan 11c2). One module, so
 * the help and the command read the same numbers.
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
 * The limit of the three routes of plan 11c2: 120 calls per IP per hour.
 * Core's limiter reads the same `OPERATOR_SECRETS_PER_IP`, which moved into
 * `@authtempo/core/operator-secret` on 2026-10-19 (ruling 16). Before that
 * date this was a copy of the value in core's `src/http/routes/operator.ts`.
 * The number is in a stop text and in the rewrap help only.
 */
export const CALLS_PER_HOUR = OPERATOR_SECRETS_PER_IP.max;
