import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";

const BASE = "https://example.test";

it("deletes an expired verification row when the cron trigger fires", async () => {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ta_verification (id, created_at, updated_at, purpose, identifier, value_hash, expires_at)
     VALUES ('sweep-old', ?1, ?1, 'magic-link', 'old@example.com', 'sweep-old-hash', ?2),
            ('sweep-live', ?1, ?1, 'magic-link', 'live@example.com', 'sweep-live-hash', ?3)`,
  )
    .bind(now - 10_000, now - 5_000, now + 600_000)
    .run();

  // SELF.scheduled does not work in @cloudflare/vitest-plugin 1.3.7, checked on
  // 2026-10-10: the call fails with a DataCloneError. Call the handler directly.
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ cron: "*/15 * * * *" }),
    // The plugin 1.3.7 types `env` as `Cloudflare.Env` and never reads a
    // `ProvidedEnv` declaration (checked 2026-10-10), so the cast stays.
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  const rows = await env.DB.prepare(
    "SELECT id FROM ta_verification WHERE id IN ('sweep-old', 'sweep-live') ORDER BY id",
  ).all<{ id: string }>();
  expect(rows.results.map((r) => r.id)).toEqual(["sweep-live"]);
});

it("limits magic link requests with the D1 limiter", async () => {
  await env.DB.prepare("DELETE FROM ta_limit").run();
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    const res = await SELF.fetch(`${BASE}/auth/magic-link/request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify({ email: `limit${i}@example.com`, next: "/me" }),
    });
    statuses.push(res.status);
  }
  expect(statuses[20]).toBe(429);
  expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);

  // The memory limiter would also answer 429. Only the owned limiter writes this table.
  const rows = await env.DB.prepare(
    "SELECT key, count FROM ta_limit WHERE key LIKE '%203.0.113.9%'",
  ).all<{ key: string; count: number }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]?.count).toBe(21);
});
