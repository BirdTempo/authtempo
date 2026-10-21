import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";

// `authtempo migrate --target sqlite --tables compat` (plan 12g Task 8b). The
// file opens through node:sqlite, the driver of the CLI seam for a file.

/** The compat migration names in order, typed here: the files of migrations/d1/. */
const COMPAT = [
  "0001_compat_better_auth",
  "0002_compat_schema_v5",
  "0003_compat_schema_v6",
  "0004_compat_schema_v7",
  "0005_compat_schema_v8",
  "0006_compat_schema_v9",
  "0007_compat_schema_v10",
  "0008_compat_schema_v11",
  "0009_compat_schema_v12",
  "0010_compat_schema_v13",
];

const COMPAT_PKG = join(PKG, "../compat-better-auth");
/** Better Auth 1.7.2's own SQLite schema, as its CLI writes it. */
const BETTER_AUTH = readFileSync(
  join(COMPAT_PKG, "test/fixtures/better-auth-1.7.2.sqlite.sql"),
  "utf8",
);
/**
 * The same tables from before Better Auth 1.7: no account.issuer and no
 * (issuer, accountId) key. It is the rule of before17 in
 * compat-better-auth/test/d1/sql.ts.
 */
const BEFORE_17 = BETTER_AUTH.replace('"issuer" text not null, ', "").replace(
  /create unique index "account_issuer_accountId_uidx"[^;]*;/,
  "",
);

let dir: string;
let file: string;
beforeAll(() => {
  assertFreshBuild();
  // A fixture that did not change would make the before-1.7 tests prove nothing.
  expect(BEFORE_17).not.toContain('"issuer"');
  expect(BEFORE_17).not.toContain("account_issuer_accountId_uidx");
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "authtempo-cli-sqlite-compat-"));
  file = join(dir, "app.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `sql` on the file with node:sqlite and no CLI in between, as the app's own tool would. */
function execOnFile(sql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Reads rows of the file with node:sqlite. */
function rowsOf(sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

const metaRows = () => rowsOf("SELECT key, value FROM ta_meta ORDER BY key");
const records = () => rowsOf("SELECT name FROM ta_migrations ORDER BY name").map((r) => r.name);

const migrate = (extra: string[] = []) =>
  runBin(["migrate", "--target", "sqlite", "--file", file, "--tables", "compat", ...extra]);

describe("authtempo migrate --target sqlite --tables compat (plan 12g Task 8b)", () => {
  it("migrates the Better Auth tables of a SQLite file", () => {
    execOnFile(BETTER_AUTH);
    const r = migrate(["--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      target: "sqlite",
      tables: "compat",
      dryRun: false,
      before: null,
      after: 13,
      pending: COMPAT,
      applied: COMPAT,
      copied: [],
      exit: 0,
      stopped: null,
    });
    expect(linesOf(r.stderr)[0]).toBe(`opening ${file}`);
    expect(metaRows()).toEqual([
      { key: "compat_better_auth", value: "10" },
      { key: "schema_version", value: "13" },
    ]);
    expect(records()).toEqual(COMPAT);
    const again = migrate(["--json"]);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      before: 13,
      after: 13,
      pending: [],
      applied: [],
    });
    expect(records()).toEqual(COMPAT);
  });

  it("applies the before-1.7 texts with --before-1.7", () => {
    execOnFile(BEFORE_17);
    const r = migrate(["--before-1.7", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ before: null, after: 13, applied: COMPAT });
    expect(rowsOf("SELECT name FROM pragma_table_info('account')").map((c) => c.name)).toContain(
      "issuer",
    );
    expect(
      rowsOf(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_account__issuer__account_id'",
      ),
    ).toHaveLength(1);
    const again = migrate(["--before-1.7", "--json"]);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ before: 13, pending: [], applied: [] });
  });

  it("stops on tables from before 1.7 without --before-1.7, and writes nothing", () => {
    execOnFile(BEFORE_17);
    const r = migrate();
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toBe(`stopped: storage: ERR_SQLITE_ERROR at ${file}`);
    // The runner makes its empty record table first. The first migration failed
    // inside its write transaction, so no record and no ta_meta stay.
    expect(
      rowsOf(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\'",
      ),
    ).toEqual([{ name: "ta_migrations" }]);
    expect(records()).toEqual([]);
  });

  it("lists the pending compat migrations with --dry-run and writes nothing", () => {
    execOnFile(BETTER_AUTH);
    const before = readFileSync(file);
    const r = migrate(["--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...COMPAT.map((n) => `would apply ${n}`),
      "version before: none; version after: none",
    ]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("goes on from the compat version that the D1 files wrote", () => {
    // As the D1 flow leaves a database: the first two shipped files, version 2 in ta_meta, no ta_migrations.
    execOnFile(BETTER_AUTH);
    for (const name of COMPAT.slice(0, 2))
      execOnFile(readFileSync(join(COMPAT_PKG, "migrations/d1", `${name}.sql`), "utf8"));
    const dry = migrate(["--dry-run", "--json"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ before: 5, pending: COMPAT.slice(2) });
    const r = migrate(["--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      before: 5,
      after: 13,
      pending: COMPAT.slice(2),
      applied: COMPAT.slice(2),
    });
    expect(records()).toEqual(COMPAT.slice(2));
  });

  it("stops on a newer database before any write", () => {
    execOnFile(BETTER_AUTH);
    expect(migrate().status).toBe(0);
    execOnFile(readFileSync(join(PKG, "test/fixtures/sqlite/0014_future.sql"), "utf8"));
    const before = readFileSync(file);
    const r = migrate();
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe(
      "stopped: the database is at version 14; this CLI knows version 13; use a newer CLI",
    );
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("stops on a missing file and makes no file, also with --dry-run", () => {
    for (const extra of [[], ["--dry-run"]]) {
      const r = migrate(extra);
      expect(r.status, extra.join(" ")).toBe(2);
      expect(linesOf(r.stderr).at(-1)).toBe(
        `stopped: no file at ${file}; --tables compat needs the file that holds the Better Auth tables; nothing was written`,
      );
      expect(existsSync(file)).toBe(false);
    }
  });
});
