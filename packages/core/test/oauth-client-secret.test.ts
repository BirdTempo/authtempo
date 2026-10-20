import { describe, expect, it, vi } from "vitest";

/**
 * The client secret compare (spec 8.16 item 1). The row holds the SHA-256
 * hex of the secret, and the check compares in constant time. A spy on
 * `constantTimeEqual` sees each compare, so a plain `===` fails this test.
 */

const seen = vi.hoisted(() => ({ compares: [] as [string, string][] }));

vi.mock("../src/primitives/crypto.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/primitives/crypto.js")>();
  return {
    ...real,
    constantTimeEqual: (a: string, b: string) => {
      seen.compares.push([a, b]);
      return real.constantTimeEqual(a, b);
    },
  };
});

const { secretMatches } = await import("../src/engine/oauth-client-secret.js");
const { constantTimeEqual, sha256Hex } = await import("../src/primitives/crypto.js");

const NOW = new Date("2026-10-20T00:00:00Z");
const CURRENT = `cs_${"a".repeat(43)}`;
const PREVIOUS = `cs_${"b".repeat(43)}`;

describe("the client secret compare (spec 8.16 item 1)", () => {
  it("compares the SHA-256 of a secret with the current and the previous hash, in constant time, in each case", async () => {
    const row = {
      secretHash: await sha256Hex(CURRENT),
      previousSecretHash: await sha256Hex(PREVIOUS),
      previousSecretUntil: new Date(NOW.getTime() + 60_000),
    };
    for (const [secret, passes] of [
      [CURRENT, true],
      [PREVIOUS, true],
      [`cs_${"c".repeat(43)}`, false],
    ] as const) {
      seen.compares = [];
      expect(await secretMatches(row, secret, NOW)).toBe(passes);
      const hash = await sha256Hex(secret);
      // Both compares run, so the time does not tell which one passed.
      expect(seen.compares).toEqual([
        [hash, row.secretHash],
        [hash, row.previousSecretHash],
      ]);
    }
    // A previous secret past its end fails, after the same two compares.
    seen.compares = [];
    const ended = { ...row, previousSecretUntil: NOW };
    expect(await secretMatches(ended, PREVIOUS, NOW)).toBe(false);
    expect(seen.compares).toHaveLength(2);
  });

  it("answers equal only for equal strings, whatever the place of a difference", () => {
    const a = "0123456789abcdef";
    expect(constantTimeEqual(a, a)).toBe(true);
    expect(constantTimeEqual(a, "x123456789abcdef")).toBe(false);
    expect(constantTimeEqual(a, "0123456789abcdex")).toBe(false);
    expect(constantTimeEqual(a, `${a}0`)).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
