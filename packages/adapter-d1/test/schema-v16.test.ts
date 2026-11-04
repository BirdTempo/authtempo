import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

async function columns(db: D1Database, table: string): Promise<Column[]> {
  return (await db.prepare(`PRAGMA table_info(${table})`).all<Column>()).results.map(
    ({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }),
  );
}

/** A user row as a Worker of version 15 writes it: only the version 15 columns. */
const user = (id: string, email: string | null, verified: 0 | 1, phone: string | null = null) =>
  env.STAGED.prepare(
    "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until, username, display_username, phone, is_anonymous) VALUES (?, 1, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0)",
  ).bind(id, email, verified, phone);

/** A session row as a Worker of version 15 writes it: only the version 15 columns. */
const session = (id: string, userId: string) =>
  env.STAGED.prepare(
    "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, ip, user_agent, active_organization_id, fresh_at, actor_id, active_team_id) VALUES (?, 1, 1, ?, ?, 4102444800000, 1, NULL, NULL, NULL, 1, NULL, NULL)",
  ).bind(id, userId, `h-${id}`);

describe("schema version 16 on D1 (plan 12p)", () => {
  it("migrates a version 15 database to 16 and fills proved from the user of each session", async () => {
    // The rows go in between the files, as a Worker of version 15 writes them, so the fill of 0016 reaches them.
    const i0016 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0016_"));
    expect(i0016).toBe(15);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0016));
    await expect(createD1Adapter(env.STAGED).findMany("session", [])).rejects.toMatchObject({
      name: "StorageError",
      code: "schema_mismatch",
      fields: ["15"],
    });
    // A verified user with an address, a claimant with an unverified address,
    // and a phone user with no address. Each has a live session.
    await env.STAGED.batch([
      user("uv", "uv@example.com", 1),
      user("uu", "uu@example.com", 0),
      user("un", null, 0, "+14155550100"),
      session("sv", "uv"),
      session("sv2", "uv"),
      session("su", "uu"),
      session("sn", "un"),
    ]);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0016 + 1));
    expect(
      await env.STAGED.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first(
        "value",
      ),
    ).toBe("16");
    expect((await columns(env.STAGED, "ta_session")).at(-1)).toEqual({
      name: "proved",
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });
    // The fill: true for each session of the verified user only.
    expect(
      (
        await env.STAGED.prepare("SELECT id, proved FROM ta_session ORDER BY id").all<{
          id: string;
          proved: number;
        }>()
      ).results,
    ).toEqual([
      { id: "sn", proved: 0 },
      { id: "su", proved: 0 },
      { id: "sv", proved: 1 },
      { id: "sv2", proved: 1 },
    ]);
    // The gate passes: the adapter reads the database at version 16 and gives a boolean.
    const db = createD1Adapter(env.STAGED);
    expect(await db.findOne("session", [{ field: "id", op: "eq", value: "sv" }])).toMatchObject({
      userId: "uv",
      tokenHash: "h-sv",
      activeTeamId: null,
      proved: true,
    });
    expect(await db.findOne("session", [{ field: "id", op: "eq", value: "sn" }])).toMatchObject({
      userId: "un",
      proved: false,
    });
    expect(
      (
        await db.findMany("session", [{ field: "proved", op: "eq", value: true }], {
          sort: { field: "id", dir: "asc" },
        })
      ).map((s) => s.id),
    ).toEqual(["sv", "sv2"]);
    // A Worker of version 15 that writes after the fill names no proved: the default gives false.
    await session("sv3", "uv").run();
    expect(await db.findOne("session", [{ field: "id", op: "eq", value: "sv3" }])).toMatchObject({
      proved: false,
    });
    // The users do not change.
    expect(
      (await db.findMany("user", [], { sort: { field: "id", dir: "asc" } })).map((u) => [
        u.id,
        u.email,
        u.emailVerified,
      ]),
    ).toEqual([
      ["un", null, false],
      ["uu", "uu@example.com", false],
      ["uv", "uv@example.com", true],
    ]);
  });

  it("migrates a database with no session", async () => {
    // test/setup.ts applies every shipped file to env.DB, which holds no row.
    expect(
      await env.DB.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first("value"),
    ).toBe("16");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ta_session").first("n")).toBe(0);
    expect((await columns(env.DB, "ta_session")).at(-1)).toMatchObject({
      name: "proved",
      notnull: 1,
    });
  });
});
