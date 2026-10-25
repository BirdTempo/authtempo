import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_SEPARATOR, type LimiterPort } from "./port.js";

/** A clock the suite moves by hand. */
export interface ManualClock {
  now(): Date;
  advance(ms: number): void;
}

export interface LimiterConformanceTarget {
  limiter: LimiterPort;
  clock: ManualClock;
  close(): Promise<void>;
}

/**
 * The tests every limiter passes: memory, D1, and Postgres. A limiter that
 * fails one does not ship. The factory gives an empty store each time.
 */
export function runLimiterConformance(
  name: string,
  factory: () => Promise<LimiterConformanceTarget>,
): void {
  describe(`limiter conformance: ${name}`, () => {
    let target: LimiterConformanceTarget;
    let limiter: LimiterPort;
    const w = { seconds: 60, max: 3 };

    beforeEach(async () => {
      target = await factory();
      limiter = target.limiter;
    });
    afterEach(async () => {
      await target.close();
    });

    async function calls(key: string, n: number, window = w): Promise<boolean[]> {
      const out: boolean[] = [];
      for (let i = 0; i < n; i++) out.push(await limiter.allow(key, window));
      return out;
    }

    it("declares its scope: isolate or shared (plan 12i)", () => {
      // A limiter with no scope counts as isolate, and createAuth then refuses `phone`.
      expect(["isolate", "shared"]).toContain(limiter.scope);
    });

    it("allows max calls in one window and refuses the next", async () => {
      expect(await calls("k", w.max + 1)).toEqual([true, true, true, false]);
      expect(await limiter.allow("k", w)).toBe(false);
    });

    it("keeps a different window on the same key independent", async () => {
      expect(await calls("k", w.max + 1)).toEqual([true, true, true, false]);
      // Each window runs to its own limit, so a stored key that drops the
      // max or the seconds shares a count with `w` and fails here.
      const other = { seconds: 60, max: 5 };
      expect(await calls("k", other.max + 1, other)).toEqual([true, true, true, true, true, false]);
      const longer = { seconds: 3600, max: 3 };
      expect(await calls("k", longer.max + 1, longer)).toEqual([true, true, true, false]);
    });

    it("still refuses one millisecond before the window ends", async () => {
      await calls("k", w.max);
      target.clock.advance(w.seconds * 1000 - 1);
      expect(await limiter.allow("k", w)).toBe(false);
    });

    it("allows the key again when the window ends, with a full new count", async () => {
      await calls("k", w.max + 1);
      target.clock.advance(w.seconds * 1000);
      expect(await calls("k", w.max + 1)).toEqual([true, true, true, false]);
    });

    it("keeps two keys apart: one key at its limit does not refuse another", async () => {
      await calls("a", w.max + 1);
      expect(await calls("b", w.max + 1)).toEqual([true, true, true, false]);
    });

    it("treats a key with `|` as an ordinary key: two keys that differ by a `|` count apart", async () => {
      expect(await calls("a|b", w.max + 1)).toEqual([true, true, true, false]);
      expect(await calls("a|", w.max + 1)).toEqual([true, true, true, false]);
      expect(await calls("ab", w.max + 1)).toEqual([true, true, true, false]);
    });

    it("throws on a window whose seconds or max is not a positive integer", async () => {
      await expect(limiter.allow("k", { seconds: 0, max: 3 })).rejects.toThrow(Error);
      await expect(limiter.allow("k", { seconds: 60, max: 0 })).rejects.toThrow(Error);
      await expect(limiter.allow("k", { seconds: 1.5, max: 3 })).rejects.toThrow(Error);
      await expect(limiter.allow("k", { seconds: 60, max: -1 })).rejects.toThrow(Error);
    });

    it("sweep removes an ended window and keeps a live one", async () => {
      const sweep = limiter.sweep?.bind(limiter);
      expect(sweep).toBeTypeOf("function");
      if (!sweep) return;
      const long = { seconds: 3600, max: 3 };
      await calls("ended", 1);
      await calls("live", 1, long);
      target.clock.advance(w.seconds * 1000);
      // Sweep before any allow: the memory limiter also drops on allow.
      expect(await sweep(target.clock.now())).toBe(1);
      expect(await sweep(target.clock.now())).toBe(0);
      // The live window kept its count: two calls are left, then it refuses.
      expect(await calls("live", 3, long)).toEqual([true, true, false]);
    });

    it("throws on a key with U+001F, the separator of the stored key", async () => {
      // The stored key is the key, the seconds, and the max, joined by U+001F.
      // A key with U+001F in it could name the bucket of another key and window.
      await expect(limiter.allow(`a${KEY_SEPARATOR}60`, w)).rejects.toThrow(Error);
      await expect(limiter.allow(`a${KEY_SEPARATOR}`, w)).rejects.toThrow(/U\+001F/);
    });
  });
}

/** The daily cap of the phone code on a shared limiter (plan 12i): each adapter package runs it. */
export { type PhoneCapTarget, runPhoneCapConformance } from "./phone-cap.js";
