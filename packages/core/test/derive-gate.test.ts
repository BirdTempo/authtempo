import { describe, expect, it } from "vitest";
import { createDeriveGate, DERIVE_GATE_MAX, deriveGate } from "../src/index.js";

/** One turn of the timer queue, so every settled promise has run its continuation. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("createDeriveGate (plan 9b2)", () => {
  it("runs at most max at once, the rest in order, and never refuses", async () => {
    const gate = createDeriveGate(2);
    const started: number[] = [];
    const release: Array<() => void> = [];
    const jobs = [0, 1, 2, 3, 4].map((i) =>
      gate.run(async () => {
        started.push(i);
        await new Promise<void>((resolve) => release.push(resolve));
        return i;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect([gate.running(), gate.waiting()]).toEqual([2, 3]);
    for (let done = 0; done < 5; done++) {
      while (release.length === 0) await tick();
      release.shift()?.();
      await tick();
      expect(gate.running()).toBeLessThanOrEqual(2);
    }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect([gate.running(), gate.waiting()]).toEqual([0, 0]);
  });

  it("frees the slot of a derive that throws", async () => {
    const gate = createDeriveGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("out of memory");
      }),
    ).rejects.toThrow("out of memory");
    expect(gate.running()).toBe(0);
    expect(await gate.run(async () => 7)).toBe(7);
  });

  it("hands the slot of a derive that throws to the next waiter (parked Task 1 Minor)", async () => {
    const gate = createDeriveGate(1);
    let fail: () => void = () => {};
    const first = gate.run(
      () =>
        new Promise<never>((_, reject) => {
          fail = () => reject(new Error("out of memory"));
        }),
    );
    let started = false;
    const second = gate.run(async () => {
      started = true;
      return 7;
    });
    await tick();
    expect([gate.running(), gate.waiting(), started]).toEqual([1, 1, false]);
    fail();
    await expect(first).rejects.toThrow("out of memory");
    await tick();
    expect(started).toBe(true);
    expect(await second).toBe(7);
    expect([gate.running(), gate.waiting()]).toEqual([0, 0]);
  });

  it("refuses a slot count that is not a whole number of at least 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => createDeriveGate(bad)).toThrow(/a whole number of slots of at least 1/);
  });

  it("exports one gate of two slots for the isolate", () => {
    expect(DERIVE_GATE_MAX).toBe(2);
    expect(deriveGate.max).toBe(DERIVE_GATE_MAX);
    expect([deriveGate.running(), deriveGate.waiting()]).toEqual([0, 0]);
  });
});
