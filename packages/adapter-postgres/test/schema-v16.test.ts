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

/** A user row as a writer of version 15 writes it: only the version 15 columns. */
const userSql = (id: string, email: string | null, verified: boolean, phone: string | null) =>
  `INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until, username, display_username, phone, is_anonymous) VALUES ('${id}', now(), now(), ${email === null ? "NULL" : `'${email}'`}, ${verified}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${phone === null ? "NULL" : `'${phone}'`}, false)`;

/** A session row as a writer of version 15 writes it: only the version 15 columns. */
const sessionSql = (id: string, userId: string) =>
  `INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, ip, user_agent, active_organization_id, fresh_at, actor_id, active_team_id) VALUES ('${id}', now(), now(), '${userId}', 'h-${id}', '2100-01-01T00:00:00Z', now(), NULL, NULL, NULL, now(), NULL, NULL)`;

describe("schema version 16 on Postgres (plan 12p)", () => {
  it("migrates a version 15 database to 16 and fills proved from the user of each session", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0016 = MIGRATIONS.findIndex((m) => m.name === "0016_schema_v16");
      expect(i0016).toBe(15);
      for (const m of MIGRATIONS.slice(0, i0016)) await a.unsafe(m.sql);
      await expect(createPostgresAdapter(a).findMany("session", [])).rejects.toMatchObject({
        name: "StorageError",
        code: "schema_mismatch",
        fields: ["15"],
      });
      // A verified user with an address, a claimant with an unverified address,
      // and a phone user with no address. Each has a live session.
      for (const q of [
        userSql("uv", "uv@example.com", true, null),
        userSql("uu", "uu@example.com", false, null),
        userSql("un", null, false, "+14155550100"),
        sessionSql("sv", "uv"),
        sessionSql("sv2", "uv"),
        sessionSql("su", "uu"),
        sessionSql("sn", "un"),
      ])
        await a.unsafe(q);
      await a.unsafe(MIGRATIONS[i0016]?.sql ?? "");
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("16");
      const columns = await a.unsafe<Column[]>(
        "SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ta_session' ORDER BY ordinal_position",
      );
      expect(columns.at(-1)).toEqual({
        column_name: "proved",
        is_nullable: "NO",
        data_type: "boolean",
        column_default: "false",
      });
      // The fill: true for each session of the verified user only.
      expect([
        ...(await a.unsafe<{ id: string; proved: boolean }[]>(
          "SELECT id, proved FROM ta_session ORDER BY id",
        )),
      ]).toEqual([
        { id: "sn", proved: false },
        { id: "su", proved: false },
        { id: "sv", proved: true },
        { id: "sv2", proved: true },
      ]);
      // The gate passes: the adapter reads the database at version 16.
      const db = createPostgresAdapter(a);
      expect(await db.findOne("session", [{ field: "id", op: "eq", value: "sv" }])).toMatchObject({
        userId: "uv",
        tokenHash: "h-sv",
        activeTeamId: null,
        proved: true,
      });
      expect(
        (
          await db.findMany("session", [{ field: "proved", op: "eq", value: false }], {
            sort: { field: "id", dir: "asc" },
          })
        ).map((s) => s.id),
      ).toEqual(["sn", "su"]);
      // A writer of version 15 after the fill names no proved: the default gives false.
      await a.unsafe(sessionSql("sv3", "uv"));
      expect(await db.findOne("session", [{ field: "id", op: "eq", value: "sv3" }])).toMatchObject({
        proved: false,
      });
    } finally {
      await close();
    }
  });

  it("migrates a database with no session", async () => {
    const { a, close } = await freshSchema();
    try {
      for (const m of MIGRATIONS) await a.unsafe(m.sql);
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("16");
      expect(await createPostgresAdapter(a).findMany("session", [])).toEqual([]);
    } finally {
      await close();
    }
  });
});
