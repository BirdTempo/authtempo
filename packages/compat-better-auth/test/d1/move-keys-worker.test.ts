import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BETTER_AUTH_API_KEY_SQLITE, BETTER_AUTH_SQLITE } from "../fixtures.js";
import worker from "./move-keys/worker.js";
import { count, execD1 } from "./schema.js";

// Better Auth's own SQLite SQL and its apikey table, then the shipped compat migrations.
await execD1(BETTER_AUTH_SQLITE);
await execD1(BETTER_AUTH_API_KEY_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const NOW = "2026-10-21T08:00:00.000Z";

/** Better Auth's digest of a key: base64url SHA-256 with no padding (`defaultKeyHasher`). */
async function digestOf(key: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** One apikey row of the user `u1`, as Better Auth 1.7.5 writes it on D1. */
async function insertKey(id: string, prefix: string) {
  const key = `${prefix}${"k".repeat(64)}${id}`;
  await env.DB.prepare(
    `INSERT INTO "apikey" ("id", "configId", "name", "start", "prefix", "key", "referenceId", "enabled", "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", "createdAt", "updatedAt") VALUES (?, 'default', 'deploy', ?, ?, ?, 'u1', 1, 1, 60000, 600, 0, ?, ?)`,
  )
    .bind(id, key.slice(0, 6), prefix, await digestOf(key), NOW, NOW)
    .run();
}

const post = (path: string) =>
  worker.fetch(new Request(`https://move.example.com${path}`, { method: "POST" }), env);

describe("the key move Worker of the compat README on D1 (final review of plan 12k, m5)", () => {
  it("refuses a stored prefix outside the list, dry-runs, and then moves", async () => {
    await env.DB.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u1', 'Ada', 'ada@example.com', 1, ?, ?)`,
    )
      .bind(NOW, NOW)
      .run();
    await insertKey("k_1", "laaa_");
    await insertKey("k_2", "ext_");
    const refused = await post("/move");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      refusals: [
        "moveBetterAuthApiKeys: no moved prefix starts the stored prefixes ext_; put each one in authtempo.movedKeyPrefixes",
      ],
    });
    await env.DB.prepare(`DELETE FROM "apikey" WHERE "id" = 'k_2'`).run();
    const dry = await post("/move");
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { moved: number }).moved).toBe(1);
    expect(await count("ta_api_token")).toBe(0);
    const moved = await post("/move?dryRun=false");
    expect(((await moved.json()) as { moved: number; byOwner: unknown }).byOwner).toEqual({
      u1: 1,
    });
    expect(await count("ta_api_token")).toBe(1);
    expect(await count("ta_moved_token")).toBe(1);
    expect((await worker.fetch(new Request("https://move.example.com/move"), env)).status).toBe(
      404,
    );
  });
});
