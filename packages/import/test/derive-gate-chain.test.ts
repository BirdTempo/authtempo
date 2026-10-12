import { betterAuthPasswordHash } from "@tempo-auth/compat-better-auth";
import { createPbkdf2PasswordHash, deriveGate } from "@tempo-auth/core";
import { createLegacyPasswordHash, type Derives, NOBLE_DERIVES } from "@tempo-auth/legacy-hashes";
import { VECTORS } from "@tempo-auth/legacy-hashes/testing";
import { describe, expect, it } from "vitest";

/**
 * A Better Auth scrypt row (spec 16.3): 32 hex salt, a colon, 128 hex key.
 * The test's scrypt answers 64 zero bytes, so this row matches with no real derive.
 */
const BA_ROW = `${"ab".repeat(16)}:${"00".repeat(64)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one derive gate for chained legacy seams (plan 9b2, Review Focus 1)", () => {
  it("runs at most two derives at once across both seams under three concurrent sign-ins", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const hold = async <T>(answer: T): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return answer;
    };
    const derives: Derives = { ...NOBLE_DERIVES, bcrypt: () => hold(true) };
    const next = betterAuthPasswordHash({
      pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      scrypt: () => hold(new Uint8Array(64)),
    });
    const seam = createLegacyPasswordHash({ formats: ["bcrypt"], next, derives });
    const answers = [
      seam.verify("pw", VECTORS.bcrypt2a.stored),
      seam.verify("pw", VECTORS.bcrypt2b.stored),
      seam.verify("pw", BA_ROW),
    ];
    while (release.length < 2) await wait(1);
    // Time for the third derive to start if a second gate let it.
    await wait(20);
    expect(inFlight).toBe(2);
    expect(deriveGate.waiting()).toBe(1);
    for (let done = 0; done < 3; done++) {
      while (release.length === 0) await wait(1);
      release.shift()?.();
    }
    expect(await Promise.all(answers)).toEqual([
      { ok: true, rehash: true },
      { ok: true, rehash: true },
      { ok: true, rehash: true },
    ]);
    expect(peak).toBe(2);
    expect(deriveGate.running()).toBe(0);
  });
});
