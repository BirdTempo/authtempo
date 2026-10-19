import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "@authtempo/adapter-postgres";
import { uniqueIndexName } from "@authtempo/core/sql";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckId, CheckReport } from "../src/checks.js";
import { type Io, nodeIo } from "../src/io.js";
import { main } from "../src/main.js";
import { SCHEMA_VERSION } from "../src/version.js";
import { PKG } from "./support/bin.js";
import { D1_MODULES, d1Project, removeScaffolds } from "./support/d1-project.js";
import { BASE, deployment, healthy } from "./support/deployment.js";
import { freshDatabase } from "./support/pg.js";

// The schema_shape check of `authtempo check` on a real database (plan 11c2
// Task 7): Docker Postgres, and the local D1 of a project through its pinned
// wrangler 4.148.0. Each drift is a hand ALTER or DROP that an operator can run.

const EMAIL_INDEX = uniqueIndexName("user", ["email"]);
const BA_FIXTURES = join(PKG, "../compat-better-auth/test/fixtures");

/** A small environment for the child processes: no variable of the developer's shell. */
const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
};

/** The real io with the output lines kept, and the fetch of a healthy deployment. */
async function cli(args: string[], o: { cwd?: string; env?: Record<string, string> } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    ...nodeIo(),
    out: (line) => {
      stdout.push(line);
    },
    err: (line) => {
      stderr.push(line);
    },
    env: { ...ENV, ...o.env },
    cwd: o.cwd ?? PKG,
    fetch: deployment(healthy()),
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

/** `authtempo check --json` with the inputs of the database. */
async function check(args: string[], o: { cwd?: string; env?: Record<string, string> }) {
  const r = await cli(["check", BASE, "--json", ...args], o);
  expect(r.stdout, r.stderr.join("\n")).toHaveLength(1);
  return { code: r.code, report: JSON.parse(r.stdout[0] ?? "") as CheckReport };
}

const result = (r: CheckReport, id: CheckId) => r.checks.find((c) => c.id === id);

/** The pinned wrangler on the local D1 of a project, with no CLI in between. It must exit 0. */
function wranglerSql(dir: string, sql: string): void {
  const r = spawnSync(
    join(D1_MODULES, ".bin/wrangler"),
    ["d1", "execute", "cli-d1", "--local", "--command", sql],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...ENV,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        // The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
        WRANGLER_HIDE_BANNER: "true",
        NO_COLOR: "1",
      },
      timeout: 120_000,
    },
  );
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
}

describe("schema_shape on Postgres (plan 11c2)", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  beforeEach(async () => {
    db = await freshDatabase();
  });
  afterEach(async () => {
    await db.drop();
  });
  const pg = () => check(["--target", "postgres"], { env: { DATABASE_URL: db.url } });
  const migrate = async (extra: string[] = []) =>
    expect(
      (await cli(["migrate", "--target", "postgres", ...extra], { env: { DATABASE_URL: db.url } }))
        .code,
    ).toBe(0);

  it("passes schema_shape on a fresh database", async () => {
    await migrate();
    const r = await pg();
    expect(r.code).toBe(0);
    expect(result(r.report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "pass",
      code: null,
      detail: "each table of the adapter's migrations has its columns, its keys, and its indexes",
    });
    expect(r.report.warnings).toEqual([]);
  });

  it("warns on an extra column and fails on a dropped unique index", async () => {
    await migrate();
    await db.sql.unsafe("ALTER TABLE ta_user ADD COLUMN nickname text");
    const extra = await pg();
    expect(extra.code).toBe(0);
    expect(result(extra.report, "schema_shape")?.status).toBe("pass");
    expect(extra.report.warnings).toEqual([
      "schema_column_extra: the table ta_user has the column nickname, which the migrations do not make",
    ]);

    await db.sql.unsafe(`DROP INDEX ${EMAIL_INDEX}`);
    const dropped = await pg();
    expect(dropped.code).toBe(1);
    expect(result(dropped.report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "fail",
      code: "schema_unique_missing",
      detail: `the table ta_user has no unique index ${EMAIL_INDEX} on the columns of the migrations`,
    });
  });

  it("fails a changed type and a NOT NULL change", async () => {
    await migrate();
    await db.sql.unsafe("ALTER TABLE ta_session ALTER COLUMN expires_at TYPE text");
    const type = await pg();
    expect(type.code).toBe(1);
    expect(result(type.report, "schema_shape")).toMatchObject({
      status: "fail",
      code: "schema_column_type",
    });
    await db.sql.unsafe(
      "ALTER TABLE ta_session ALTER COLUMN expires_at TYPE timestamptz USING expires_at::timestamptz",
    );
    await db.sql.unsafe("ALTER TABLE ta_user ALTER COLUMN name SET NOT NULL");
    const notNull = await pg();
    expect(notNull.code).toBe(1);
    expect(result(notNull.report, "schema_shape")).toMatchObject({
      status: "fail",
      code: "schema_column_null",
    });
  });

  it("warns on an extra NOT NULL column with no default as a column that breaks each insert", async () => {
    await migrate();
    await db.sql.unsafe("ALTER TABLE ta_user ADD COLUMN plan text NOT NULL DEFAULT 'x'");
    await db.sql.unsafe("ALTER TABLE ta_user ALTER COLUMN plan DROP DEFAULT");
    const r = await pg();
    expect(r.code).toBe(0);
    expect(r.report.warnings).toEqual([
      "schema_column_extra_required: the table ta_user has the NOT NULL column plan with no default: each insert of core into ta_user fails",
    ]);
  });

  it("skips schema_shape with schema_not_current on a database one version behind", async () => {
    // An older adapter: the migrations up to the version before, each with its row, as applyPostgresMigrations writes it.
    await db.sql.unsafe(
      "CREATE TABLE ta_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const m of MIGRATIONS.slice(0, SCHEMA_VERSION - 1))
      await db.sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx.unsafe("INSERT INTO ta_migrations (name) VALUES ($1)", [m.name]);
      });
    const r = await pg();
    expect(r.code).toBe(1);
    expect(result(r.report, "schema_version")).toMatchObject({
      status: "fail",
      code: "schema_behind",
    });
    // The test password "tempo" is in the scrub list, so the detail prints "auth***": check.test.ts pins the text.
    expect(result(r.report, "schema_shape")).toMatchObject({
      status: "skip",
      code: "schema_not_current",
    });
  });

  it("skips schema_shape with compat_database on a database of the compat migrations", async () => {
    await db.sql.unsafe(readFileSync(join(BA_FIXTURES, "better-auth-1.7.2.postgres.sql"), "utf8"));
    await migrate(["--tables", "compat"]);
    const r = await pg();
    expect(r.code).toBe(0);
    expect(result(r.report, "schema_version")?.status).toBe("pass");
    expect(result(r.report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "skip",
      code: "compat_database",
      detail:
        "the database holds the Better Auth compatibility tables; the shape of core's tables does not apply",
    });
  });
});

afterAll(() => {
  removeScaffolds();
});

// Each check calls the project's wrangler five times on its local D1.
describe("schema_shape on D1 (plan 11c2)", { timeout: 300_000 }, () => {
  const d1 = (dir: string) => check(["--target", "d1"], { cwd: dir });

  it("passes schema_shape on a fresh database", async () => {
    const p = d1Project();
    expect((await cli(["migrate", "--target", "d1"], { cwd: p.dir })).code).toBe(0);
    const r = await d1(p.dir);
    expect(r.code).toBe(0);
    expect(result(r.report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "pass",
      code: null,
      detail: "each table of the adapter's migrations has its columns, its keys, and its indexes",
    });
    expect(r.report.warnings).toEqual([]);
  });

  it("warns on an extra column and fails on a dropped unique index", async () => {
    const p = d1Project();
    expect((await cli(["migrate", "--target", "d1"], { cwd: p.dir })).code).toBe(0);
    wranglerSql(p.dir, "ALTER TABLE ta_user ADD COLUMN nickname text");
    const extra = await d1(p.dir);
    expect(extra.code).toBe(0);
    expect(result(extra.report, "schema_shape")?.status).toBe("pass");
    expect(extra.report.warnings).toEqual([
      "schema_column_extra: the table ta_user has the column nickname, which the migrations do not make",
    ]);

    wranglerSql(p.dir, `DROP INDEX ${EMAIL_INDEX}`);
    const dropped = await d1(p.dir);
    expect(dropped.code).toBe(1);
    expect(result(dropped.report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "fail",
      code: "schema_unique_missing",
      detail: `the table ta_user has no unique index ${EMAIL_INDEX} on the columns of the migrations`,
    });
  });

  it("skips schema_shape with compat_database on a database of the compat migrations", async () => {
    const p = d1Project({
      migrationsDir: "migrations",
      files: {
        "migrations/0001_better_auth.sql": readFileSync(
          join(BA_FIXTURES, "better-auth-1.7.2.sqlite.sql"),
          "utf8",
        ),
      },
    });
    const migrated = await cli(["migrate", "--target", "d1", "--tables", "compat"], {
      cwd: p.dir,
    });
    expect(migrated.code, migrated.stderr.join("\n")).toBe(0);
    const r = await d1(p.dir);
    expect(r.code).toBe(0);
    expect(result(r.report, "schema_version")?.status).toBe("pass");
    expect(result(r.report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "skip",
      code: "compat_database",
      detail:
        "the database holds the Better Auth compatibility tables; the shape of core's tables does not apply",
    });
  });
});
