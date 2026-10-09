import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LimiterPort } from "./port.js";

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

    it("allows max calls in one window and refuses the next", async () => {
      expect(await calls("k", w.max + 1)).toEqual([true, true, true, false]);
      expect(await limiter.allow("k", w)).toBe(false);
    });

    it("keeps a different window on the same key independent", async () => {
      expect(await calls("k", w.max + 1)).toEqual([true, true, true, false]);
      const other = { seconds: 60, max: 5 };
      expect(await calls("k", 1, other)).toEqual([true]);
      const longer = { seconds: 3600, max: 3 };
      expect(await calls("k", 1, longer)).toEqual([true]);
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

    it("rejects a key that contains the separator `|` with a thrown Error", async () => {
      // The stored key is `${key}|${seconds}|${max}`. A key with `|` in it
      // could then name the bucket of another key and window.
      await expect(limiter.allow("a|60|3", w)).rejects.toThrow(Error);
      await expect(limiter.allow("a|", w)).rejects.toThrow(/\|/);
    });
  });
}
