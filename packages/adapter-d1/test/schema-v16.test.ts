import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import schemaPage from "../../../apps/site/src/content/docs/docs/reference/schema.md?raw";
import shippedText from "../migrations/0016_schema_v16.sql?raw";
import readme from "../README.md?raw";
import { createD1Adapter } from "../src/index.js";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

async function columns(db: D1Database, table: string): Promise<Column[]> {
  return (await db.prepare(`PRAGMA table_info(${table})`).all<Column>()).results.map(
    ({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }),
  );
}

/** A user row as a Worker of version 15 writes it: only the version 15 columns. */
const user = (
  id: string,
  email: string | null,
  verified: 0 | 1,
  phone: string | null = null,
  db: D1Database = env.STAGED,
) =>
  db
    .prepare(
      "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until, username, display_username, phone, is_anonymous) VALUES (?, 1, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0)",
    )
    .bind(id, email, verified, phone);

/** A session row as a Worker of version 15 writes it: only the version 15 columns. */
const session = (id: string, userId: string, db: D1Database = env.STAGED) =>
  db
    .prepare(
      "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, ip, user_agent, active_organization_id, fresh_at, actor_id, active_team_id) VALUES (?, 1, 1, ?, ?, 4102444800000, 1, NULL, NULL, NULL, 1, NULL, NULL)",
    )
    .bind(id, userId, `h-${id}`);

/**
 * The fill by hand: the SQL of each `wrangler d1 execute` command of a record, in order. The
 * comment of 0016, this package's README, and the schema page of the site hold the same five.
 */
const byHand = (record: string): string[] =>
  [...record.matchAll(/wrangler d1 execute my-app --remote (?:--json )?--command "([^"]+)"/g)].map(
    (m) => m[1] ?? "",
  );

/**
 * The part of a page that gives the fill by hand: from the paragraph of the D1 fill to the end of
 * its command block. A page holds the commands of other versions too.
 */
const fillPart = (page: string): string => {
  const start = page.indexOf("On D1, the fill of `0016_schema_v16` is one statement.");
  const end = page.indexOf("\n```\n", start);
  if (start < 0 || end < 0) throw new Error("the page has no part on the D1 fill of version 16");
  return page.slice(start, end);
};

const rows = async (db: D1Database, sql: string) => (await db.prepare(sql).all()).results;

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

  it("fills by hand in pages with the commands of the records, to the rows of the shipped fill", async () => {
    // The commands of the comment of 0016: the count, the column, one page, the version, the mark.
    const steps = byHand(shippedText);
    expect(steps).toHaveLength(5);
    const [count = "", column = "", fill = "", version = "", mark = ""] = steps;
    // The column and the version are the statements of the file itself.
    expect(shippedText).toContain(`\n${column};\n`);
    expect(shippedText).toContain(`\n${version};\n`);
    // A page of 3 in place of 10,000. Seven sessions of verified users then take three pages.
    expect(fill.split("LIMIT 10000")).toHaveLength(2);
    const page = fill.replace("LIMIT 10000", "LIMIT 3");
    const i0016 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0016_"));
    // The same rows at version 15 in two databases. Two verified users with an address, one with
    // no session; a claimant with an unverified address; a phone user with no address.
    for (const db of [env.PAGED, env.PAGED_COPY]) {
      await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, i0016));
      await db.batch([
        user("ua", "ua@example.com", 1, null, db),
        user("ub", "ub@example.com", 1, "+14155550101", db),
        user("ue", "ue@example.com", 1, null, db),
        user("uc", "uc@example.com", 0, null, db),
        user("ud", null, 0, "+14155550102", db),
        ...["a1", "a2", "a3", "a4"].map((id) => session(id, "ua", db)),
        ...["b1", "b2", "b3"].map((id) => session(id, "ub", db)),
        session("c1", "uc", db),
        session("c2", "uc", db),
        session("d1", "ud", db),
      ]);
    }
    // The copy takes the shipped file, as wrangler d1 migrations apply runs it.
    await applyD1Migrations(env.PAGED_COPY, env.TEST_MIGRATIONS);
    // By hand: the count, the column, the pages until no row changes, the version, the mark.
    expect(await env.PAGED.prepare(count).first("sessions")).toBe(7);
    await env.PAGED.prepare(column).run();
    const changes: number[] = [];
    for (let round = 0; round < 10; round++) {
      const { meta } = await env.PAGED.prepare(page).run();
      changes.push(meta.changes);
      if (meta.changes === 0) break;
    }
    expect(changes).toEqual([3, 3, 1, 0]);
    await env.PAGED.prepare(version).run();
    await env.PAGED.prepare(mark).run();
    // Every row and column equals the copy.
    expect(await columns(env.PAGED, "ta_session")).toEqual(
      await columns(env.PAGED_COPY, "ta_session"),
    );
    for (const sql of [
      "SELECT * FROM ta_session ORDER BY id",
      "SELECT * FROM ta_user ORDER BY id",
      "SELECT * FROM ta_meta ORDER BY key",
      "SELECT name FROM d1_migrations ORDER BY id",
    ])
      expect(await rows(env.PAGED, sql)).toEqual(await rows(env.PAGED_COPY, sql));
    expect(
      (await rows(env.PAGED, "SELECT id FROM ta_session WHERE proved = 1 ORDER BY id")).map(
        (r) => r.id,
      ),
    ).toEqual(["a1", "a2", "a3", "a4", "b1", "b2", "b3"]);
    // The mark holds the name that the runner reads, so a new run skips 0016. A run of
    // 0016 again would fail with duplicate column name: proved.
    await applyD1Migrations(env.PAGED, env.TEST_MIGRATIONS);
    expect(await rows(env.PAGED, "SELECT name FROM d1_migrations ORDER BY id")).toEqual(
      await rows(env.PAGED_COPY, "SELECT name FROM d1_migrations ORDER BY id"),
    );
    // The README and the schema page give the same commands as the comment.
    expect(byHand(fillPart(readme))).toEqual(steps);
    expect(byHand(fillPart(schemaPage))).toEqual(steps);
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
