import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

describe("schema version 12 on Postgres (plan 12f)", () => {
  it("refuses a database at version 11, then reads its user and session with no ban and no actor after 0012", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0012 = MIGRATIONS.findIndex((m) => m.name === "0012_schema_v12");
      expect(i0012).toBe(11);
      for (const m of MIGRATIONS.slice(0, i0012)) await a.unsafe(m.sql);
      await expect(createPostgresAdapter(a).findMany("user", [])).rejects.toMatchObject({
        name: "StorageError",
        code: "schema_mismatch",
        fields: ["11"],
      });
      // A writer of version 11 names only the version 11 columns.
      await a.unsafe(
        "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image) VALUES ('u11', now(), now(), 'u11@example.com', true, NULL, NULL)",
      );
      await a.unsafe(
        "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, fresh_at) VALUES ('s11', now(), now(), 'u11', 'h11', now() + interval '1 day', now(), now())",
      );
      for (const m of MIGRATIONS.slice(i0012)) await a.unsafe(m.sql);
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("12");
      const cols = await a.unsafe<
        {
          table_name: string;
          column_name: string;
          is_nullable: string;
          data_type: string;
          column_default: string | null;
        }[]
      >(
        "SELECT table_name, column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND ((table_name = 'ta_user' AND column_name LIKE 'ban%') OR (table_name = 'ta_session' AND column_name = 'actor_id')) ORDER BY table_name DESC, ordinal_position",
      );
      expect([...cols]).toEqual([
        {
          table_name: "ta_user",
          column_name: "banned_at",
          is_nullable: "YES",
          data_type: "timestamp with time zone",
          column_default: null,
        },
        {
          table_name: "ta_user",
          column_name: "ban_reason",
          is_nullable: "YES",
          data_type: "text",
          column_default: null,
        },
        {
          table_name: "ta_user",
          column_name: "ban_until",
          is_nullable: "YES",
          data_type: "timestamp with time zone",
          column_default: null,
        },
        {
          table_name: "ta_session",
          column_name: "actor_id",
          is_nullable: "YES",
          data_type: "text",
          column_default: null,
        },
      ]);
      const db = createPostgresAdapter(a);
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u11" }])).toMatchObject({
        bannedAt: null,
        banReason: null,
        banUntil: null,
      });
      expect(
        (await db.findOne("session", [{ field: "id", op: "eq", value: "s11" }]))?.actorId,
      ).toBeNull();
    } finally {
      await close();
    }
  });
});
