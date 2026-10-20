import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

describe("schema version 12 on D1 (plan 12f)", () => {
  it("adds the ban columns, actor_id, and ta_operator_audit, each nullable column with no default", async () => {
    const columns = async (table: string) =>
      (
        await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }>()
      ).results.map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    expect((await columns("ta_user")).slice(-3)).toEqual([
      { name: "banned_at", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "ban_reason", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "ban_until", type: "INTEGER", notnull: 0, dflt_value: null },
    ]);
    // Plan 12k adds active_team_id after actor_id.
    expect((await columns("ta_session")).at(-2)).toEqual({
      name: "actor_id",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
    });
    expect((await columns("ta_operator_audit")).map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "actor_kind",
      "actor_id",
      "action",
      "target_user_id",
      "reason",
      "data",
      "ip",
      "user_agent",
    ]);
    // env.DB holds every migration (0013 since plan 12k), so read the version that 0012 itself writes.
    const m0012 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0012_"));
    expect(
      m0012?.queries.some((q) =>
        q.includes("UPDATE ta_meta SET value = '12' WHERE key = 'schema_version'"),
      ),
    ).toBe(true);
  });

  it("refuses a database at version 11, then reads its user and session with no ban and no actor after 0012", async () => {
    // The rows go in between the files, as a Worker of version 11 writes them, so a fill in 0012 would reach them.
    const i0012 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0012_"));
    expect(i0012).toBe(11);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0012));
    await expect(createD1Adapter(env.STAGED).findMany("user", [])).rejects.toMatchObject({
      name: "StorageError",
      code: "schema_mismatch",
      fields: ["11"],
    });
    await env.STAGED.prepare(
      "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image) VALUES ('u11', 1, 1, 'u11@example.com', 1, NULL, NULL)",
    ).run();
    await env.STAGED.prepare(
      "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, fresh_at) VALUES ('s11', 1, 1, 'u11', 'h11', 4102444800000, 1, 1)",
    ).run();
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS);
    const db = createD1Adapter(env.STAGED);
    expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u11" }])).toMatchObject({
      bannedAt: null,
      banReason: null,
      banUntil: null,
    });
    expect(
      (await db.findOne("session", [{ field: "id", op: "eq", value: "s11" }]))?.actorId,
    ).toBeNull();
  });
});
