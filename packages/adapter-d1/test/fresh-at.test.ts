import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

describe("schema version 10 on D1 (plan 12a)", () => {
  it("adds ta_session.fresh_at as a nullable integer and moves the version to 10", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(ta_session)").all<{
      name: string;
      type: string;
      notnull: number;
    }>();
    expect(cols.results.find((c) => c.name === "fresh_at")).toMatchObject({
      type: "INTEGER",
      notnull: 0,
    });
    expect(
      await env.DB.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first("value"),
    ).toBe("10");
  });

  it("reads freshAt null on a session row that version 9 wrote before 0010", async () => {
    // The row goes in between the files, so a fill in 0010 would reach it.
    const i0010 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0010_"));
    expect(i0010).toBe(9);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0010));
    await env.STAGED.prepare(
      "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at) VALUES ('s9', 1, 1, 'u9', 'h9', 4102444800000, 1)",
    ).run();
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS);
    const row = await createD1Adapter(env.STAGED).findOne("session", [
      { field: "id", op: "eq", value: "s9" },
    ]);
    expect(row?.freshAt).toBeNull();
  });
});
