import { env } from "cloudflare:test";
import { limiterKey } from "@tempo-auth/core";
import { runLimiterConformance } from "@tempo-auth/core/limiter-conformance";
import { expect, it } from "vitest";
import { createD1Limiter } from "../src/index.js";

async function clear(): Promise<void> {
  await env.DB.prepare("DELETE FROM ta_limit").run();
}

function manualClock() {
  let t = new Date("2026-01-01T00:00:00.000Z").getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

runLimiterConformance("d1", async () => {
  await clear();
  const clock = manualClock();
  return { limiter: createD1Limiter(env.DB, clock), clock, close: clear };
});

it("lets exactly one of two concurrent calls at max - 1 pass", async () => {
  // The guard is the one statement: D1 runs one statement at a time, so the
  // two upserts cannot both read max - 1. A read-then-write limiter fails here
  // only when the two reads interleave, so this test is the record of the race.
  await clear();
  const w = { seconds: 60, max: 3 };
  const limiter = createD1Limiter(env.DB, manualClock());
  for (let i = 0; i < w.max - 1; i++) expect(await limiter.allow("race", w)).toBe(true);
  const both = await Promise.all([limiter.allow("race", w), limiter.allow("race", w)]);
  expect(both.filter((b) => b)).toHaveLength(1);
  const row = await env.DB.prepare("SELECT count FROM ta_limit WHERE key = ?1")
    .bind(limiterKey("race", w))
    .first<{ count: number }>();
  expect(row?.count).toBe(w.max + 1);
  await clear();
});
