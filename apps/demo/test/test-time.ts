// One source of the time limit of the demo pool tests. It imports nothing,
// so vitest.config.ts can read it.

/**
 * The time limit of a pool test that walks many routes or every flow (final
 * review of plan 12e, L9). The default of 5 s failed an unfiltered run: the
 * outbound test passed 5008 ms there (one-minute load 3.5 to 8.1). Measured on
 * 2026-10-20 alone, the four tests of this limit took 0.38 to 1.3 s. While
 * core, compat, and the adapters ran their tests (load 15 to 31), they took
 * up to 2.3 s. Each test grows with the flows, so the limit is 20 s.
 *
 * Review n3 of plan 12e added the two user route tests of limits.test.ts.
 * An unfiltered run took 5009 and 5002 ms (load 3.1 before, 9.1 after). On
 * 2026-10-20 the file alone took 274 and 242 ms (load 6.8). The whole demo
 * suite took 2933 and 2641 ms (load 6.9 before, 13.8 after).
 *
 * An evidence run of plan 12e then timed out a third test at 5005 ms. Each
 * pool test runs a full Worker sandbox, so vitest.config.ts sets this limit
 * for every pool test, and no test waits for its own review.
 */
export const LONG_TEST_MS = 20_000;
