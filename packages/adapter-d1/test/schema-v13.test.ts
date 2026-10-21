import { applyD1Migrations, env } from "cloudflare:test";
import { schema } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

async function columns(db: D1Database, table: string): Promise<Column[]> {
  return (await db.prepare(`PRAGMA table_info(${table})`).all<Column>()).results.map(
    ({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }),
  );
}

const nullable = (name: string, type: string): Column => ({
  name,
  type,
  notnull: 0,
  dflt_value: null,
});

describe("schema version 13 on D1 (plan 12k)", () => {
  it("migrates a version 12 database to 13 and keeps every row", async () => {
    // The rows go in between the files, as a Worker of version 12 writes them, so a fill in 0013 would reach them.
    const i0013 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0013_"));
    expect(i0013).toBe(12);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0013));
    await expect(createD1Adapter(env.STAGED).findMany("user", [])).rejects.toMatchObject({
      name: "StorageError",
      code: "schema_mismatch",
      fields: ["12"],
    });
    // A writer of version 12 names only the version 12 columns.
    await env.STAGED.batch(
      [
        "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until) VALUES ('u12', 1, 1, 'u12@example.com', 1, NULL, NULL, NULL, NULL, NULL)",
        "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, active_organization_id, fresh_at, actor_id) VALUES ('s12', 1, 1, 'u12', 'h12', 4102444800000, 1, 'o12', 1, NULL)",
        "INSERT INTO ta_invitation (id, created_at, updated_at, organization_id, email, role, inviter_id, token_hash, expires_at, accepted_at) VALUES ('i12', 1, 1, 'o12', 'b@example.com', 'member', 'u12', 'ih12', 4102444800000, NULL)",
        "INSERT INTO ta_api_token (id, created_at, updated_at, user_id, name, token_hash, hint, expires_at, last_used_at, organization_id) VALUES ('t12', 1, 1, 'u12', 'ci', 'th12', 'abcdefgh', NULL, 1, 'o12')",
      ].map((q) => env.STAGED.prepare(q)),
    );
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0013 + 1));
    expect(
      await env.STAGED.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first(
        "value",
      ),
    ).toBe("13");
    // The adapter reads only a database of the current version: apply the later migrations first (0014 since plan 12d).
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS);
    expect((await columns(env.STAGED, "ta_session")).at(-1)).toEqual(
      nullable("active_team_id", "TEXT"),
    );
    expect((await columns(env.STAGED, "ta_invitation")).at(-1)).toEqual(
      nullable("team_ids", "TEXT"),
    );
    expect((await columns(env.STAGED, "ta_api_token")).slice(-9)).toEqual([
      nullable("permissions", "TEXT"),
      nullable("metadata", "TEXT"),
      nullable("rate_limit_seconds", "INTEGER"),
      nullable("rate_limit_max", "INTEGER"),
      nullable("remaining", "INTEGER"),
      nullable("refill_amount", "INTEGER"),
      nullable("refill_seconds", "INTEGER"),
      nullable("last_refill_at", "INTEGER"),
      nullable("retired_at", "INTEGER"),
    ]);
    // The gate passes: the adapter reads the database at version 13.
    const db = createD1Adapter(env.STAGED);
    expect(await db.findOne("session", [{ field: "id", op: "eq", value: "s12" }])).toMatchObject({
      userId: "u12",
      tokenHash: "h12",
      activeOrganizationId: "o12",
      actorId: null,
      activeTeamId: null,
    });
    expect(await db.findOne("invitation", [{ field: "id", op: "eq", value: "i12" }])).toMatchObject(
      { tokenHash: "ih12", acceptedAt: null, teamIds: null },
    );
    expect(await db.findOne("apiToken", [{ field: "id", op: "eq", value: "t12" }])).toEqual({
      id: "t12",
      createdAt: new Date(1),
      updatedAt: new Date(1),
      userId: "u12",
      name: "ci",
      tokenHash: "th12",
      hint: "abcdefgh",
      expiresAt: null,
      lastUsedAt: new Date(1),
      organizationId: "o12",
      permissions: null,
      metadata: null,
      rateLimitSeconds: null,
      rateLimitMax: null,
      remaining: null,
      refillAmount: null,
      refillSeconds: null,
      lastRefillAt: null,
      retiredAt: null,
    });
    expect(await db.findMany("user", [])).toHaveLength(1);
  });

  it("names every model of the schema", async () => {
    const models = Object.keys(schema) as (keyof typeof schema)[];
    // 27 models to version 13; plan 12d adds six.
    expect(models).toHaveLength(33);
    const tables = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta_%'",
      ).all<{ name: string }>()
    ).results.map((r) => r.name);
    for (const model of models)
      expect({ model, table: tables.includes(TABLES[model]) }).toEqual({
        model,
        table: true,
      });
    expect((await columns(env.DB, "ta_organization_role")).map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "organization_id",
      "name",
      "rank",
      "permissions",
    ]);
    expect((await columns(env.DB, "ta_team")).map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "organization_id",
      "name",
    ]);
    expect((await columns(env.DB, "ta_team_member")).map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "team_id",
      "organization_id",
      "user_id",
    ]);
    expect((await columns(env.DB, "ta_organization_token")).map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "organization_id",
      "created_by_id",
      "name",
      "token_hash",
      "hint",
      "permissions",
      "metadata",
      "expires_at",
      "last_used_at",
      "rate_limit_seconds",
      "rate_limit_max",
      "remaining",
      "refill_amount",
      "refill_seconds",
      "last_refill_at",
      "retired_at",
    ]);
    expect((await columns(env.DB, "ta_moved_token")).map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "source",
      "source_id",
      "token_id",
    ]);
    const indexes = (
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('ta_organization_role', 'ta_team', 'ta_team_member', 'ta_organization_token', 'ta_moved_token') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
      ).all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexes).toEqual([
      "ix_ta_organization_token__organization_id",
      "ix_ta_team__organization_id",
      "ix_ta_team_member__organization_id__user_id",
      "ix_ta_team_member__user_id",
      "ux_ta_moved_token__source__source_id",
      "ux_ta_organization_role__organization_id__name",
      "ux_ta_organization_token__token_hash",
      "ux_ta_team_member__team_id__user_id",
    ]);
  });
});
