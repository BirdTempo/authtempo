import { expect, it } from "vitest";
import { createMemoryLimiter } from "../src/limiter/memory.js";

it("allows max calls per window, then refuses, then resets after the window", async () => {
  let t = new Date("2026-01-01T00:00:00Z");
  const limiter = createMemoryLimiter({ now: () => t });
  const w = { seconds: 60, max: 2 };
  expect(await limiter.allow("k", w)).toBe(true);
  expect(await limiter.allow("k", w)).toBe(true);
  expect(await limiter.allow("k", w)).toBe(false);
  expect(await limiter.allow("other", w)).toBe(true);
  t = new Date(t.getTime() + 61_000);
  expect(await limiter.allow("k", w)).toBe(true);
});

it("drops expired buckets so memory does not grow without bound", async () => {
  let t = new Date("2026-01-01T00:00:00Z");
  const limiter = createMemoryLimiter({ now: () => t });
  const w = { seconds: 60, max: 2 };
  for (const k of ["a", "b", "c"]) await limiter.allow(k, w);
  expect(limiter.size()).toBe(3);
  t = new Date(t.getTime() + 61_000);
  await limiter.allow("d", w);
  expect(limiter.size()).toBe(1);
});

it("sweeps each bucket by its own window, not the window of the caller", async () => {
  let t = new Date("2026-01-01T00:00:00Z");
  const limiter = createMemoryLimiter({ now: () => t });
  const hour = { seconds: 3600, max: 2 };
  const minute = { seconds: 60, max: 1 };
  expect(await limiter.allow("A", hour)).toBe(true);
  expect(await limiter.allow("A", hour)).toBe(true);
  expect(await limiter.allow("B", minute)).toBe(true);
  t = new Date(t.getTime() + 61_000);
  expect(await limiter.allow("B", minute)).toBe(true);
  expect(await limiter.allow("A", hour)).toBe(false);
});

it("treats one key under two windows as two independent limits", async () => {
  let t = new Date("2026-01-01T00:00:00Z");
  const t0 = t.getTime();
  const limiter = createMemoryLimiter({ now: () => t });
  const short = { seconds: 60, max: 1 };
  const long = { seconds: 3600, max: 2 };
  expect(await limiter.allow("K", short)).toBe(true);
  t = new Date(t0 + 30_000);
  expect(await limiter.allow("K", long)).toBe(true);
  t = new Date(t0 + 61_000);
  expect(await limiter.allow("K", long)).toBe(true);
  t = new Date(t0 + 62_000);
  expect(await limiter.allow("K", long)).toBe(false);
});
