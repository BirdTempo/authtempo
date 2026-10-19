/**
 * The call limits of `authtempo secret rewrap` (plan 11c2). One module with
 * no import, so the help and the command read the same two numbers.
 */

/**
 * The most calls of one run, by default. At the default limit of 100 rows
 * a call, 100 calls move 10 000 rows. The limiter of core allows 120 calls
 * an hour.
 */
export const DEFAULT_MAX_CALLS = 100;

/** The most calls that `--max-calls` takes. */
export const MAX_CALLS_MAX = 10_000;
