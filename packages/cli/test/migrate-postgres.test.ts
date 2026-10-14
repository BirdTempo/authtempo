import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { COMPAT_MIGRATION_NAMES } from "@authtempo/compat-better-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATE_JSON_KEYS } from "../src/json.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { freshDatabase } from "./support/pg.js";

const CORE = [
  "0001_schema_v1",
  "0002_schema_v2",
  "0003_schema_v3",
  "0004_schema_v4",
  "0005_schema_v5",
  "0006_schema_v6",
  "0007_schema_v7",
  "0008_schema_v8",
  "0009_schema_v9",
];
const COMPAT = [
  "0001_compat_better_auth",
  "0002_compat_schema_v5",
  "0003_compat_schema_v6",
  "0004_compat_schema_v7",
  "0005_compat_schema_v8",
  "0006_compat_schema_v9",
];

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeAll(() => {
  assertFreshBuild();
});
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.drop();
});

const migrate = (extra: string[], url = db.url) =>
  runBin(["migrate", "--target", "postgres", "--url-env", "TEST_DB_URL", ...extra], {
    env: { TEST_DB_URL: url },
  });

describe("authtempo migrate --target postgres (spec 19)", () => {
  it("applies 0001 to 0009 on a fresh database, prints each, and moves the version from none to 9", () => {
    const r = migrate([]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...CORE.map((n) => `applied ${n}`),
      "version before: none; version after: 9",
    ]);
    expect(linesOf(r.stderr)[0]).toMatch(/^connecting to \S+:\d+\/cli_/);
  });

  it("applies nothing on a second run", () => {
    expect(migrate([]).status).toBe(0);
    const r = migrate([]);
    expect(r.status).toBe(0);
    expect(linesOf(r.stdout)).toEqual(["version before: 9; version after: 9"]);
  });

  it("lists the pending migrations on --dry-run and writes nothing", async () => {
    const r = migrate(["--dry-run"]);
    expect(r.status).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...CORE.map((n) => `would apply ${n}`),
      "version before: none; version after: none",
    ]);
    const reg = await db.sql<
      { t: string | null }[]
    >`SELECT to_regclass('ta_migrations')::text AS t`;
    expect(reg[0]?.t).toBeNull();
  });

  it("stops before any write on a database at version 10, written by a migration fixture", async () => {
    await applyPostgresMigrations(db.sql);
    await db.sql.unsafe(readFileSync(join(PKG, "test/fixtures/postgres/0010_future.sql"), "utf8"));
    const r = migrate([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe(
      "stopped: the database is at version 10; this CLI knows version 9; use a newer CLI",
    );
    const count = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ta_migrations`;
    expect(count[0]?.n).toBe("10");
  });

  it("stops before any write on a schema_version it cannot read, and names the raw value", async () => {
    await applyPostgresMigrations(db.sql);
    await db.sql`UPDATE ta_meta SET value = 'seven' WHERE key = 'schema_version'`;
    const word = migrate([]);
    expect(word.status).toBe(2);
    expect(word.stdout).toBe("");
    expect(linesOf(word.stderr).at(-1)).toBe(
      'stopped: ta_meta holds schema_version "seven", which is not a version number; nothing was written',
    );
    await db.sql`DELETE FROM ta_meta WHERE key = 'schema_version'`;
    const missing = migrate([]);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe("");
    expect(linesOf(missing.stderr).at(-1)).toBe(
      "stopped: ta_meta has no schema_version, but ta_migrations holds 9 applied migration(s); nothing was written",
    );
    expect(linesOf(missing.stderr)).not.toContain("applying 0 migration(s)");
    const rows = await db.sql<
      { n: string }[]
    >`SELECT count(*)::text AS n FROM ta_meta WHERE key = 'schema_version'`;
    expect(rows[0]?.n).toBe("0");
  });

  it("prints one JSON document of the run with --json", () => {
    const r = migrate(["--json"]);
    expect(r.status).toBe(0);
    expect(linesOf(r.stdout)).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(MIGRATE_JSON_KEYS).sort());
    expect(doc).toEqual({
      target: "postgres",
      tables: "core",
      dryRun: false,
      before: null,
      after: 9,
      pending: CORE,
      applied: CORE,
      copied: [],
    });
    expect(linesOf(r.stderr)).toContain("version before: none; version after: 9");
  });

  it("applies the compat migrations on a Better Auth schema with --tables compat, then lists none", async () => {
    await db.sql.unsafe(
      readFileSync(
        join(PKG, "../compat-better-auth/test/fixtures/better-auth-1.7.2.postgres.sql"),
        "utf8",
      ),
    );
    const r = migrate(["--tables", "compat"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...COMPAT.map((n) => `applied ${n}`),
      "version before: none; version after: 9",
    ]);
    const dry = migrate(["--tables", "compat", "--dry-run"]);
    expect(linesOf(dry.stdout)).toEqual(["version before: 9; version after: 9"]);
  });

  it("stops with the compatibility package's own error on a schema with core's tables", async () => {
    await applyPostgresMigrations(db.sql);
    const r = migrate(["--tables", "compat"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toMatch(/^stopped: .*already exists/);
  });

  it("stops with exit 2 on a refused connection, and no output holds the password", () => {
    const r = migrate([], "postgres://app:s3cret-canary@127.0.0.1:1/none");
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toBe(
      "stopped: storage: ECONNREFUSED at 127.0.0.1:1/none; nothing was written",
    );
    expect(r.stdout + r.stderr).not.toContain("s3cret-canary");
  });

  it("names a refused login by its SQLSTATE and the host only: no line names the user", () => {
    const url = db.url.replace(/\/\/[^@]+@/, "//no_such_user_canary:wrong-pass-canary@");
    const r = migrate([], url);
    expect(r.status).toBe(2);
    const host = new URL(url);
    expect(linesOf(r.stderr).at(-1)).toBe(
      `stopped: storage: 28P01 at ${host.hostname}:${host.port}${host.pathname}; nothing was written`,
    );
    expect(r.stdout + r.stderr).not.toContain("canary");
  });

  it("reads the connection string from --url-file and from stdin", () => {
    const dir = join(PKG, ".scaffold");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `url-${crypto.randomUUID()}.txt`);
    writeFileSync(file, `${db.url}\n`, { mode: 0o600 });
    try {
      const fromFile = runBin(["migrate", "--target", "postgres", "--url-file", file, "--dry-run"]);
      expect(fromFile.status, fromFile.stderr).toBe(0);
    } finally {
      // The file holds the test connection string: no test leaves it behind.
      rmSync(file, { force: true });
    }
    const fromStdin = runBin(["migrate", "--target", "postgres", "--url-file", "-", "--dry-run"], {
      input: db.url,
    });
    expect(fromStdin.status, fromStdin.stderr).toBe(0);
  });

  it("names the near target of a typo, and needs a target", () => {
    const typo = runBin(["migrate", "--target", "postgress"]);
    expect(typo.status).toBe(2);
    expect(linesOf(typo.stderr)[0]).toContain("Did you mean postgres?");
    const none = runBin(["migrate"]);
    expect(none.status).toBe(2);
    expect(linesOf(none.stderr)[0]).toMatch(/^name a target: --target /);
  });

  it("reads the compat migration names from the compatibility package, the same as its files", () => {
    expect([...COMPAT_MIGRATION_NAMES]).toEqual(COMPAT);
    for (const dir of ["d1", "d1-before-1.7"]) {
      const files = readdirSync(join(PKG, "../compat-better-auth/migrations", dir))
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => f.slice(0, -".sql".length));
      expect(files, dir).toEqual([...COMPAT_MIGRATION_NAMES]);
    }
  });
});
