import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { applyOneVersionBelow, freshDatabase } from "./support/pg.js";

// The version gate of `authtempo import` (plan 11f Task 3; spec 23 item 4):
// an import writes only into a database at the CLI's own version. The gate
// runs at the open of the storage, before the first row read or write, so a
// stop writes nothing. Each run is a child process on a fresh docker compose
// Postgres. The version literals are typed, not read from the constant.

const SUPABASE = FIXTURE_EXPORTS.supabase;
const RUN = [
  "import",
  "supabase",
  "--users",
  "users.csv",
  "--identities",
  "identities.csv",
  "--formats",
  SUPABASE.formats.join(","),
  "--target",
  "postgres",
  "--url-env",
  "TEST_DB_URL",
];
const MIGRATE_FIRST = "run authtempo migrate --target postgres first; nothing was written";

let dir: string;
let db: Awaited<ReturnType<typeof freshDatabase>>;

beforeAll(() => {
  assertFreshBuild();
  dir = mkdtempSync(join(tmpdir(), "authtempo-gate-"));
  for (const name of ["users", "identities"] as const) {
    const text = SUPABASE.bundle.files[name];
    if (text === undefined) throw new Error(`the Supabase fixture has no ${name} file`);
    writeFileSync(join(dir, `${name}.csv`), text);
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.drop();
});

/**
 * The child's URL and environment. The compose password `tempo` is a part
 * of `authtempo`, and the scrub of spec 19 writes `auth***` for it in every
 * line. So the URL carries no password, and the driver reads it from
 * PGPASSWORD (postgres.js README, "Environment Variables", read 2026-10-19).
 */
function connection(): { url: string; password: string } {
  const u = new URL(db.url);
  const password = decodeURIComponent(u.password);
  u.password = "";
  return { url: u.href, password };
}

const run = (extra: string[] = []) => {
  const c = connection();
  return runBin([...RUN, ...extra], {
    cwd: dir,
    env: { TEST_DB_URL: c.url, PGPASSWORD: c.password },
  });
};

/** The row count of each `ta_` table of the public schema, by name. */
async function rowCounts(): Promise<Record<string, string>> {
  const tables = await db.sql<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'ta\\_%' ORDER BY table_name`;
  const out: Record<string, string> = {};
  for (const t of tables) {
    const n = await db.sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.name}`);
    out[t.name] = n[0]?.n ?? "";
  }
  return out;
}

it("stops before any write on a database with no schema", async () => {
  const r = run();
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(linesOf(r.stderr).at(-1)).toBe(
    `stopped: the database has no schema of authtempo; ${MIGRATE_FIRST}`,
  );
  expect(await rowCounts()).toEqual({});
});

it("stops before any write on a database one version below", async () => {
  await applyOneVersionBelow(db.sql);
  const before = await rowCounts();
  expect(before.ta_migrations).toBe("9");
  const r = run();
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(linesOf(r.stderr).at(-1)).toBe(
    `stopped: the database is at version 9; this CLI writes version 10; ${MIGRATE_FIRST}`,
  );
  expect(await rowCounts()).toEqual(before);
});

it("stops before any write on a database one version above", async () => {
  await applyPostgresMigrations(db.sql);
  await db.sql.unsafe(readFileSync(join(PKG, "test/fixtures/postgres/0011_future.sql"), "utf8"));
  const before = await rowCounts();
  const r = run();
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(linesOf(r.stderr).at(-1)).toBe(
    "stopped: the database is at version 11; this CLI knows version 10; use a newer CLI; nothing was written",
  );
  expect(await rowCounts()).toEqual(before);
});

it("names --tables compat in the stop of a compat import", async () => {
  await applyOneVersionBelow(db.sql);
  const before = await rowCounts();
  const r = run(["--tables", "compat"]);
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(linesOf(r.stderr).at(-1)).toBe(
    "stopped: the database is at version 9; this CLI writes version 10; run authtempo migrate --target postgres --tables compat first; nothing was written",
  );
  expect(await rowCounts()).toEqual(before);
});

it("stops a dry run too", async () => {
  await applyOneVersionBelow(db.sql);
  const r = run(["--dry-run"]);
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(linesOf(r.stderr).at(-1)).toBe(
    `stopped: the database is at version 9; this CLI writes version 10; ${MIGRATE_FIRST}`,
  );
});

it("imports into a database at the CLI's version", async () => {
  await applyPostgresMigrations(db.sql);
  const r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(linesOf(r.stdout)).toContain("hashes: bcrypt 1, argon2id 1");
  expect((await rowCounts()).ta_user).toBe("2");
});
