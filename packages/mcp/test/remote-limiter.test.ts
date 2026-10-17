// The token bucket of the remote Worker (plan 11e Task 16, review m-2), with a
// fake clock. The values are literals: 120 calls a minute, and 10,000 keys at
// most. The test does not read LIMITS or BUCKET_KEYS, the values that it pins.
import { describe, expect, it } from "vitest";
import { tokenBucket } from "../src/remote-limiter.js";

/** A clock that the test moves by hand. */
function fakeClock() {
  let now = 0;
  return { clock: () => now, set: (t: number) => (now = t) };
}

const LIMITS = { callsPerMinute: 120, windowMs: 60_000 };

describe("the token bucket", () => {
  it("refuses the 121st call and fills again at an even rate", () => {
    const t = fakeClock();
    const bucket = tokenBucket(LIMITS, t.clock);
    for (let i = 1; i <= 120; i++) expect(bucket.take("a"), `call ${i}`).toBe(true);
    expect(bucket.take("a")).toBe(false);
    // 120 tokens a minute is one token each 500 ms.
    t.set(499);
    expect(bucket.take("a")).toBe(false);
    t.set(600);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(false);
    // A full minute later the bucket is full again, and not fuller.
    t.set(62_000);
    for (let i = 1; i <= 120; i++) expect(bucket.take("a"), `call ${i} after a minute`).toBe(true);
    expect(bucket.take("a")).toBe(false);
  });

  it("keeps at most 10,000 keys and drops the key with the oldest call", () => {
    const t = fakeClock();
    const bucket = tokenBucket(LIMITS, t.clock);
    for (let i = 1; i <= 120; i++) bucket.take("drained");
    expect(bucket.take("drained")).toBe(false);
    // 9,999 other keys fill the map to 10,000 with "drained" in it.
    for (let i = 0; i < 9_999; i++) expect(bucket.take(`k${i}`)).toBe(true);
    // A refusal is a call too: "drained" moves to the end of the order.
    expect(bucket.take("drained")).toBe(false);
    // One more key drops k0, the key with the oldest call, and keeps "drained".
    expect(bucket.take("k-new")).toBe(true);
    expect(bucket.take("drained")).toBe(false);
    // 10,000 more keys push "drained" out. It comes back as a new, full key.
    for (let i = 0; i < 10_000; i++) bucket.take(`m${i}`);
    expect(bucket.take("drained")).toBe(true);
  });
});
