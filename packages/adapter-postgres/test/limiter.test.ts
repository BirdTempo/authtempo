import { limiterKey } from "@tempo-auth/core";
import { runLimiterConformance } from "@tempo-auth/core/limiter-conformance";
import { expect, it } from "vitest";
import { createPostgresLimiter } from "../src/index.js";
import { freshDatabase } from "./db.js";

function manualClock() {
  let t = new Date("2026-01-01T00:00:00.000Z").getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

runLimiterConformance("postgres", async () => {
  const db = await freshDatabase();
  const clock = manualClock();
  return { limiter: createPostgresLimiter(db.sql, clock), clock, close: () => db.close() };
});

it("lets exactly one of two concurrent calls at max - 1 pass", async () => {
  // The client has four connections, so the two upserts run on two sessions
  // at once. The row lock of the one statement is the guard.
  const db = await freshDatabase();
  try {
    const w = { seconds: 60, max: 3 };
    const limiter = createPostgresLimiter(db.sql, manualClock());
    for (let i = 0; i < w.max - 1; i++) expect(await limiter.allow("race", w)).toBe(true);
    const both = await Promise.all([limiter.allow("race", w), limiter.allow("race", w)]);
    expect(both.filter((b) => b)).toHaveLength(1);
    const rows = await db.sql.unsafe<{ count: string }[]>(
      "SELECT count FROM ta_limit WHERE key = $1",
      [limiterKey("race", w)],
    );
    expect(Number(rows[0]?.count)).toBe(w.max + 1);
  } finally {
    await db.close();
  }
});

it("lets exactly max of twenty concurrent calls pass", async () => {
  // Two calls alone did not interleave on this pool in the proof run
  // (2026-10-10): a read-then-write limiter passed the test above. Twenty
  // calls over four connections do interleave, and that limiter fails here.
  const db = await freshDatabase();
  try {
    const w = { seconds: 60, max: 3 };
    const limiter = createPostgresLimiter(db.sql, manualClock());
    const all = await Promise.all(Array.from({ length: 20 }, () => limiter.allow("burst", w)));
    expect(all.filter((b) => b)).toHaveLength(w.max);
  } finally {
    await db.close();
  }
});

it("stores window_start and count as bigint", async () => {
  const db = await freshDatabase();
  try {
    const cols = await db.sql.unsafe<{ column_name: string; data_type: string }[]>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ta_limit' ORDER BY ordinal_position",
    );
    expect(cols.map((c) => [c.column_name, c.data_type])).toEqual([
      ["key", "text"],
      ["window_start", "bigint"],
      ["count", "bigint"],
    ]);
  } finally {
    await db.close();
  }
});
