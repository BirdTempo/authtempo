import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Stop } from "../src/errors.js";
import { importGate } from "../src/schema-version.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { applyOneVersionBelow, freshDatabase } from "./support/pg.js";

// The version gate of `authtempo import` (plan 11f Task 3; spec 23 item 4).
// An import writes only into a database at the CLI's own version. The gate
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
/** A compat import on a database that only core's migrations made. */
const CORE_ONLY =
  "the database holds the tables of core and no Better Auth tables of an app; leave out --tables compat for the tables of core, or point --url-env at the Better Auth database of the app; nothing was written";
/** A core import on a database that only the compat run made. */
const COMPAT_ONLY =
  "the database holds the Better Auth tables of an app; add --tables compat; nothing was written";

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
    "stopped: the database has no schema of authtempo; run authtempo migrate --target postgres first, or add --tables compat for the Better Auth tables of an app; nothing was written",
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

it("stops a compat import before any write on a core schema with no compat tables", async () => {
  await applyPostgresMigrations(db.sql);
  const before = await rowCounts();
  for (const extra of [[], ["--dry-run"]]) {
    const r = run(["--tables", "compat", ...extra]);
    expect(r.status, extra.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe(`stopped: ${CORE_ONLY}`);
  }
  expect(await rowCounts()).toEqual(before);
});

it("stops a core import before any write on a Better Auth database after the compat run", async () => {
  await db.sql.unsafe(
    readFileSync(
      join(PKG, "../compat-better-auth/test/fixtures/better-auth-1.7.2.postgres.sql"),
      "utf8",
    ),
  );
  const c = connection();
  const m = runBin(
    ["migrate", "--target", "postgres", "--url-env", "TEST_DB_URL", "--tables", "compat"],
    { env: { TEST_DB_URL: c.url, PGPASSWORD: c.password } },
  );
  expect(m.status, m.stderr).toBe(0);
  const before = await rowCounts();
  for (const extra of [[], ["--dry-run"]]) {
    const r = run(extra);
    expect(r.status, extra.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe(`stopped: ${COMPAT_ONLY}`);
  }
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

/** The line of the Stop that `importGate` throws, or null when it passes. */
function stopOf(
  version: number | null,
  tables: "core" | "compat",
  appliedCore: number,
  compatVersion: number,
): string | null {
  try {
    importGate(version, tables, { appliedCore, compatVersion });
    return null;
  } catch (e) {
    if (e instanceof Stop) return e.message;
    throw e;
  }
}

describe("importGate and the two table sets", () => {
  const FIX = "run authtempo migrate --target postgres --tables compat first; nothing was written";

  it("stops a compat import on compat tables below or above the package's version", () => {
    expect(stopOf(10, "compat", 0, 6)).toBe(
      `the compat tables are at version 6; this CLI writes version 7; ${FIX}`,
    );
    expect(stopOf(10, "compat", 0, 8)).toBe(
      "the compat tables are at version 8; this CLI knows version 7; use a newer CLI; nothing was written",
    );
    expect(stopOf(10, "compat", 0, 7)).toBeNull();
  });

  it("names the other table set when the database holds only one", () => {
    expect(stopOf(10, "compat", 10, 0)).toBe(CORE_ONLY);
    expect(stopOf(10, "core", 0, 7)).toBe(COMPAT_ONLY);
  });

  it("names the compat set in the stop of a core import on a database with no schema", () => {
    expect(stopOf(null, "core", 0, 0)).toBe(
      "the database has no schema of authtempo; run authtempo migrate --target postgres first, or add --tables compat for the Better Auth tables of an app; nothing was written",
    );
    expect(stopOf(null, "compat", 0, 0)).toBe(`the database has no schema of authtempo; ${FIX}`);
  });

  it("reads the core version first, and passes a core import on core's tables", () => {
    expect(stopOf(9, "compat", 9, 0)).toBe(
      `the database is at version 9; this CLI writes version 10; ${FIX}`,
    );
    expect(stopOf(10, "core", 10, 0)).toBeNull();
  });
});

it("imports into a database at the CLI's version", async () => {
  await applyPostgresMigrations(db.sql);
  const r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(linesOf(r.stdout)).toContain("hashes: bcrypt 1, argon2id 1");
  expect((await rowCounts()).ta_user).toBe("2");
});
