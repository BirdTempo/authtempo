import { describe, expect, it } from "vitest";
import { newMonotonicId } from "../src/primitives/ids.js";

// The monotonic ULID of the audit rows (ruling 58 Q4 and the final review
// m4 of plan 12f). The module state is the last id of this file's isolate,
// so each test starts at a time later than any test before it.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The value of a Crockford base32 string, as a bigint. */
function value(text: string): bigint {
  let n = 0n;
  for (const c of text) n = n * 32n + BigInt(ALPHABET.indexOf(c));
  return n;
}

describe("newMonotonicId (plan 12f)", () => {
  it("gives the previous random part plus 1 in one millisecond", () => {
    const now = new Date("2090-01-01T00:00:00.000Z");
    const first = newMonotonicId(now);
    let previous = first;
    for (let i = 0; i < 1000; i++) {
      const next = newMonotonicId(now);
      expect(next.slice(0, 10)).toBe(first.slice(0, 10));
      expect(value(next.slice(10))).toBe(value(previous.slice(10)) + 1n);
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  it("gives the previous id plus 1 when the clock goes back", () => {
    const first = newMonotonicId(new Date("2091-01-01T00:00:00.001Z"));
    const back = newMonotonicId(new Date("2091-01-01T00:00:00.000Z"));
    const farBack = newMonotonicId(new Date("2026-01-01T00:00:00.000Z"));
    expect(back.slice(0, 10)).toBe(first.slice(0, 10));
    expect(value(back)).toBe(value(first) + 1n);
    expect(value(farBack)).toBe(value(back) + 1n);
  });

  it("gives a new time part in a later millisecond", () => {
    const first = newMonotonicId(new Date("2092-01-01T00:00:00.000Z"));
    const later = newMonotonicId(new Date("2092-01-01T00:00:00.001Z"));
    expect(value(later.slice(0, 10))).toBe(value(first.slice(0, 10)) + 1n);
    // 2092-01-01T00:00:00.001Z is 3849984000001 ms after the epoch.
    expect(value(later.slice(0, 10))).toBe(3849984000001n);
    expect(later > first).toBe(true);
  });
});
