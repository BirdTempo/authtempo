// The owned limits of the remote Worker (plan 11e Task 16). The Worker checks
// each one before the SDK reads a byte. The SDK has its own body limit of
// 4 MiB (DEFAULT_MAX_REQUEST_BODY_SIZE, 2.3.1), which is far above ours. So
// these values, not a supplier default, keep the promise. This file imports no
// Node module and no Workers type, because the Worker and the tests read it.

export const LIMITS = {
  /** A docs call is under 1 KiB; 64 KiB leaves room and refuses a flood. */
  bodyBytes: 65_536,
  // The next three keys are copies. tools.ts and resources.ts enforce them.
  // test/pool/remote.test.ts holds each copy to the value on the wire.
  /** The longest docs.search query. */
  queryChars: 200,
  /** The most hits of one docs.search call. */
  limit: 10,
  /** The entries of one resources/list page (RESOURCE_PAGE of resources.ts). */
  resourcePage: 100,
  /** Per isolate and per IP; it is weak across isolates, and it is ours. */
  callsPerMinute: 120,
  /** The window of callsPerMinute, in milliseconds. */
  windowMs: 60_000,
} as const;

export type Limits = typeof LIMITS;
