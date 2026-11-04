import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

async function columns(db: D1Database, table: string): Promise<Column[]> {
  return (await db.prepare(`PRAGMA table_info(${table})`).all<Column>()).results.map(
    ({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }),
  );
}

const column = (name: string, type: string, notnull = 0, dflt_value: unknown = null): Column => ({
  name,
  type,
  notnull,
  dflt_value,
});

describe("schema version 15 on D1 (plan 12i)", () => {
  it("migrates a version 14 database to 15 and keeps every row", async () => {
    // The rows go in between the files, as a Worker of version 14 writes them, so the rebuild of 0015 copies them.
    const i0015 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0015_"));
    expect(i0015).toBe(14);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0015));
    await expect(createD1Adapter(env.STAGED).findMany("user", [])).rejects.toMatchObject({
      name: "StorageError",
      code: "schema_mismatch",
      fields: ["14"],
    });
    // A writer of version 14 names only the version 14 columns.
    await env.STAGED.batch(
      [
        "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until) VALUES ('u14', 1, 2, 'u14@example.com', 1, 'Ada', NULL, 3, 'spam', NULL)",
        "INSERT INTO ta_passkey (id, created_at, updated_at, user_id, credential_id, public_key, counter, transports, device_type, backed_up, name) VALUES ('p14', 1, 1, 'u14', 'c14', 'pk', 7, NULL, 'singleDevice', 0, NULL)",
        "INSERT INTO ta_oauth_session_client (id, created_at, updated_at, session_id, client_id, user_id, sid) VALUES ('l14', 1, 1, 's14', 'cl_14', 'u14', 'sid14')",
      ].map((q) => env.STAGED.prepare(q)),
    );
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0015 + 1));
    expect(
      await env.STAGED.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first(
        "value",
      ),
    ).toBe("15");
    const user = await columns(env.STAGED, "ta_user");
    expect(user.find((c) => c.name === "email")).toEqual(column("email", "TEXT"));
    expect(user.slice(-4)).toEqual([
      column("username", "TEXT"),
      column("display_username", "TEXT"),
      column("phone", "TEXT"),
      column("is_anonymous", "INTEGER", 1, "0"),
    ]);
    expect((await columns(env.STAGED, "ta_passkey")).slice(-3)).toEqual([
      column("discoverable", "INTEGER"),
      column("prf", "INTEGER", 1, "0"),
      column("large_blob", "INTEGER", 1, "0"),
    ]);
    // The issuer of a back-channel link and of its logout (plan 12i Task 18).
    for (const table of ["ta_oauth_session_client", "ta_oauth_logout"])
      expect((await columns(env.STAGED, table)).at(-1)).toEqual(column("issuer", "TEXT"));
    // The adapter reads only a database of the current version: apply the later migrations first (0016 since plan 12p).
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS);
    // The gate passes: the adapter reads the rows of version 14.
    const db = createD1Adapter(env.STAGED);
    expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u14" }])).toEqual({
      id: "u14",
      createdAt: new Date(1),
      updatedAt: new Date(2),
      email: "u14@example.com",
      emailVerified: true,
      name: "Ada",
      image: null,
      bannedAt: new Date(3),
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
    // A link of version 14 holds no issuer: its logout names the primary.
    expect(
      await db.findOne("oauthSessionClient", [{ field: "id", op: "eq", value: "l14" }]),
    ).toMatchObject({ sid: "sid14", issuer: null });
    // A user with no address, and the unique key on email that still refuses a second equal address.
    const at = new Date(5);
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
      await env.STAGED.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ta_user' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
      ).all<{ name: string; sql: string }>()
    ).results;
    expect(indexes.map((r) => r.name)).toEqual([
      "ix_ta_user__is_anonymous__created_at",
      "ux_ta_user__email",
      "ux_ta_user__phone",
      "ux_ta_user__username",
    ]);
    // The read of the anonymous step of the sweep (ruling 25 H1).
    expect(indexes[0]?.sql).toBe(
      "CREATE INDEX ix_ta_user__is_anonymous__created_at ON ta_user (is_anonymous, created_at)",
    );
  });
});
