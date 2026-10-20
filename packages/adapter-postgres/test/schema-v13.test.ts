import { schema } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshDatabase, freshSchema } from "./db.js";

type Column = {
  table_name: string;
  column_name: string;
  is_nullable: string;
  data_type: string;
  column_default: string | null;
};

const nullable = (table_name: string, column_name: string, data_type: string): Column => ({
  table_name,
  column_name,
  is_nullable: "YES",
  data_type,
  column_default: null,
});

describe("schema version 13 on Postgres (plan 12k)", () => {
  it("migrates a version 12 database to 13 and keeps every row", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0013 = MIGRATIONS.findIndex((m) => m.name === "0013_schema_v13");
      expect(i0013).toBe(12);
      for (const m of MIGRATIONS.slice(0, i0013)) await a.unsafe(m.sql);
      await expect(createPostgresAdapter(a).findMany("user", [])).rejects.toMatchObject({
        name: "StorageError",
        code: "schema_mismatch",
        fields: ["12"],
      });
      // A writer of version 12 names only the version 12 columns.
      await a.unsafe(
        "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until) VALUES ('u12', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 'u12@example.com', true, NULL, NULL, NULL, NULL, NULL)",
      );
      await a.unsafe(
        "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, active_organization_id, fresh_at, actor_id) VALUES ('s12', now(), now(), 'u12', 'h12', now() + interval '1 day', now(), 'o12', now(), NULL)",
      );
      await a.unsafe(
        "INSERT INTO ta_invitation (id, created_at, updated_at, organization_id, email, role, inviter_id, token_hash, expires_at, accepted_at) VALUES ('i12', now(), now(), 'o12', 'b@example.com', 'member', 'u12', 'ih12', now() + interval '1 day', NULL)",
      );
      await a.unsafe(
        "INSERT INTO ta_api_token (id, created_at, updated_at, user_id, name, token_hash, hint, expires_at, last_used_at, organization_id) VALUES ('t12', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 'u12', 'ci', 'th12', 'abcdefgh', NULL, '2026-10-20T00:00:00Z', 'o12')",
      );
      for (const m of MIGRATIONS.slice(i0013)) await a.unsafe(m.sql);
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("13");
      const cols = await a.unsafe<Column[]>(
        "SELECT table_name, column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND ((table_name = 'ta_session' AND column_name = 'active_team_id') OR (table_name = 'ta_invitation' AND column_name = 'team_ids') OR (table_name = 'ta_api_token' AND ordinal_position > 10)) ORDER BY table_name DESC, ordinal_position",
      );
      expect([...cols]).toEqual([
        nullable("ta_session", "active_team_id", "text"),
        nullable("ta_invitation", "team_ids", "jsonb"),
        nullable("ta_api_token", "permissions", "jsonb"),
        nullable("ta_api_token", "metadata", "jsonb"),
        nullable("ta_api_token", "rate_limit_seconds", "integer"),
        nullable("ta_api_token", "rate_limit_max", "integer"),
        nullable("ta_api_token", "remaining", "integer"),
        nullable("ta_api_token", "refill_amount", "integer"),
        nullable("ta_api_token", "refill_seconds", "integer"),
        nullable("ta_api_token", "last_refill_at", "timestamp with time zone"),
        nullable("ta_api_token", "retired_at", "timestamp with time zone"),
      ]);
      // The gate passes: the adapter reads the database at version 13.
      const db = createPostgresAdapter(a);
      expect(await db.findOne("session", [{ field: "id", op: "eq", value: "s12" }])).toMatchObject({
        userId: "u12",
        tokenHash: "h12",
        activeOrganizationId: "o12",
        actorId: null,
        activeTeamId: null,
      });
      expect(
        await db.findOne("invitation", [{ field: "id", op: "eq", value: "i12" }]),
      ).toMatchObject({ tokenHash: "ih12", acceptedAt: null, teamIds: null });
      const at = new Date("2026-10-20T00:00:00.000Z");
      expect(await db.findOne("apiToken", [{ field: "id", op: "eq", value: "t12" }])).toEqual({
        id: "t12",
        createdAt: at,
        updatedAt: at,
        userId: "u12",
        name: "ci",
        tokenHash: "th12",
        hint: "abcdefgh",
        expiresAt: null,
        lastUsedAt: at,
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
    } finally {
      await close();
    }
  });

  it("names every model of the schema", async () => {
    const models = Object.keys(schema) as (keyof typeof schema)[];
    expect(models).toHaveLength(27);
    const db = await freshDatabase();
    try {
      const tables = (
        await db.sql.unsafe<{ table_name: string }[]>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
        )
      ).map((r) => r.table_name);
      for (const model of models)
        expect({ model, table: tables.includes(TABLES[model]) }).toEqual({ model, table: true });
      const columnsOf = async (table: string) =>
        (
          await db.sql.unsafe<{ column_name: string; data_type: string }[]>(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
            [table],
          )
        ).map((c) => `${c.column_name} ${c.data_type}`);
      const at = "timestamp with time zone";
      expect(await columnsOf("ta_organization_role")).toEqual([
        "id text",
        `created_at ${at}`,
        `updated_at ${at}`,
        "organization_id text",
        "name text",
        "rank integer",
        "permissions jsonb",
      ]);
      expect(await columnsOf("ta_team")).toEqual([
        "id text",
        `created_at ${at}`,
        `updated_at ${at}`,
        "organization_id text",
        "name text",
      ]);
      expect(await columnsOf("ta_team_member")).toEqual([
        "id text",
        `created_at ${at}`,
        `updated_at ${at}`,
        "team_id text",
        "organization_id text",
        "user_id text",
      ]);
      expect(await columnsOf("ta_organization_token")).toEqual([
        "id text",
        `created_at ${at}`,
        `updated_at ${at}`,
        "organization_id text",
        "created_by_id text",
        "name text",
        "token_hash text",
        "hint text",
        "permissions jsonb",
        "metadata jsonb",
        `expires_at ${at}`,
        `last_used_at ${at}`,
        "rate_limit_seconds integer",
        "rate_limit_max integer",
        "remaining integer",
        "refill_amount integer",
        "refill_seconds integer",
        `last_refill_at ${at}`,
        `retired_at ${at}`,
      ]);
      expect(await columnsOf("ta_moved_token")).toEqual([
        "id text",
        `created_at ${at}`,
        `updated_at ${at}`,
        "source text",
        "source_id text",
        "token_id text",
      ]);
      const indexes = (
        await db.sql.unsafe<{ indexname: string }[]>(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('ta_organization_role', 'ta_team', 'ta_team_member', 'ta_organization_token', 'ta_moved_token') AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
        )
      ).map((r) => r.indexname);
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
    } finally {
      await db.close();
    }
  });
});
