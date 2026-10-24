import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

type Column = {
  column_name: string;
  is_nullable: string;
  data_type: string;
  column_default: string | null;
};

const column = (
  column_name: string,
  data_type: string,
  is_nullable = "YES",
  column_default: string | null = null,
): Column => ({ column_name, is_nullable, data_type, column_default });

describe("schema version 15 on Postgres (plan 12i)", () => {
  it("migrates a version 14 database to 15 and keeps every row", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0015 = MIGRATIONS.findIndex((m) => m.name === "0015_schema_v15");
      expect(i0015).toBe(14);
      for (const m of MIGRATIONS.slice(0, i0015)) await a.unsafe(m.sql);
      await expect(createPostgresAdapter(a).findMany("user", [])).rejects.toMatchObject({
        name: "StorageError",
        code: "schema_mismatch",
        fields: ["14"],
      });
      // A writer of version 14 names only the version 14 columns.
      await a.unsafe(
        "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until) VALUES ('u14', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', 'u14@example.com', true, 'Ada', NULL, '2026-10-22T00:00:00Z', 'spam', NULL)",
      );
      await a.unsafe(
        "INSERT INTO ta_passkey (id, created_at, updated_at, user_id, credential_id, public_key, counter, transports, device_type, backed_up, name) VALUES ('p14', now(), now(), 'u14', 'c14', 'pk', 7, NULL, 'singleDevice', false, NULL)",
      );
      await a.unsafe(MIGRATIONS[i0015]?.sql ?? "");
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("15");
      const columnsOf = async (table: string) => [
        ...(await a.unsafe<Column[]>(
          "SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
          [table],
        )),
      ];
      const user = await columnsOf("ta_user");
      expect(user.find((c) => c.column_name === "email")).toEqual(column("email", "text"));
      expect(user.slice(-4)).toEqual([
        column("username", "text"),
        column("display_username", "text"),
        column("phone", "text"),
        column("is_anonymous", "boolean", "NO", "false"),
      ]);
      expect((await columnsOf("ta_passkey")).slice(-3)).toEqual([
        column("discoverable", "boolean"),
        column("prf", "boolean", "NO", "false"),
        column("large_blob", "boolean", "NO", "false"),
      ]);
      // The gate passes: the adapter reads the database at version 15.
      const db = createPostgresAdapter(a);
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u14" }])).toEqual({
        id: "u14",
        createdAt: new Date("2026-10-20T00:00:00.000Z"),
        updatedAt: new Date("2026-10-21T00:00:00.000Z"),
        email: "u14@example.com",
        emailVerified: true,
        name: "Ada",
        image: null,
        bannedAt: new Date("2026-10-22T00:00:00.000Z"),
        banReason: "spam",
        banUntil: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: false,
      });
      expect(await db.findOne("passkey", [{ field: "id", op: "eq", value: "p14" }])).toMatchObject({
        counter: 7,
        discoverable: null,
        prf: false,
        largeBlob: false,
      });
      // A user with no address, and the unique key on email that still refuses a second equal address.
      const at = new Date("2026-10-23T00:00:00.000Z");
      const row = {
        emailVerified: false,
        name: null,
        image: null,
        bannedAt: null,
        banReason: null,
        banUntil: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: false,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("user", { ...row, id: "n1", email: null });
      await db.create("user", { ...row, id: "n2", email: null });
      await expect(
        db.create("user", { ...row, id: "u15", email: "u14@example.com" }),
      ).rejects.toMatchObject({ name: "StorageError", code: "unique_violation", model: "user" });
      expect(
        (
          await db.findMany("user", [{ field: "email", op: "eq", value: null }], {
            sort: { field: "id", dir: "asc" },
          })
        ).map((u) => u.id),
      ).toEqual(["n1", "n2"]);
      const indexes = (
        await a.unsafe<{ indexname: string }[]>(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'ta_user' AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
        )
      ).map((r) => r.indexname);
      expect(indexes).toEqual(["ux_ta_user__email", "ux_ta_user__phone", "ux_ta_user__username"]);
    } finally {
      await close();
    }
  });
});
