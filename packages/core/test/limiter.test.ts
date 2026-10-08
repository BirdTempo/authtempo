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
