import { betterAuthPasswordHash } from "@authtempo/compat-better-auth";
import { createPbkdf2PasswordHash, deriveGate } from "@authtempo/core";
import { createLegacyPasswordHash, type Derives, NOBLE_DERIVES } from "@authtempo/legacy-hashes";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
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
    // Poll until two derives hold a slot and the third waits in core's gate,
    // at most 1000 turns. A second gate would let the third derive start, so
    // the loop would end on the bound and the checks below would fail.
    for (let i = 0; i < 1000 && (release.length < 2 || deriveGate.waiting() < 1); i++)
      await wait(1);
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
