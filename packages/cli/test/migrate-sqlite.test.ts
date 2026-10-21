import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckId, CheckReport } from "../src/checks.js";
import { main } from "../src/main.js";
import { SCHEMA_VERSION } from "../src/version.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { BASE, deployment, healthy } from "./support/deployment.js";
import { fakeIo } from "./support/fake-io.js";

// `authtempo migrate --target sqlite` and `check --target sqlite` (plan 12g
// Task 6). A file opens through node:sqlite; a URL opens the libSQL server
// authtempo-libsql-cli of docker-compose.yml, which only this file uses.

/** The names of the SQLite migrations, typed here: the D1 files of adapter-d1. */
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
  "0010_schema_v10",
  "0011_schema_v11",
  "0012_schema_v12",
  "0013_schema_v13",
];

/** The CLI's own libSQL server (ruling 1 of plan 12g, map point 15). */
const LIBSQL_URL = process.env.AUTHTEMPO_LIBSQL_CLI_URL ?? "http://127.0.0.1:8090";

let dir: string;
let file: string;
beforeAll(() => {
  assertFreshBuild();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "authtempo-cli-sqlite-"));
  file = join(dir, "app.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const migrateFile = (extra: string[] = []) =>
  runBin(["migrate", "--target", "sqlite", "--file", file, ...extra]);

/** The `ta_` tables of the file, read with node:sqlite and no CLI in between. */
function taTables(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\'",
      )
      .all()
      .map((r) => String(r.name))
      .sort();
  } finally {
    db.close();
  }
}

describe("authtempo migrate --target sqlite (plan 12g Task 6)", () => {
  it("migrates a new file and reaches the CLI's version", () => {
    const r = migrateFile(["--json"]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(doc).toEqual({
      target: "sqlite",
      tables: "core",
      dryRun: false,
      before: null,
      after: 13,
      pending: CORE,
      applied: CORE,
      copied: [],
      exit: 0,
      stopped: null,
    });
    expect(doc.after).toBe(SCHEMA_VERSION);
    expect(linesOf(r.stderr)[0]).toBe(`opening ${file}`);
    const again = migrateFile(["--json"]);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      before: 13,
      after: 13,
      pending: [],
      applied: [],
    });
  });

  it("makes a new file with mode 0600 and keeps the mode of a file that exists", () => {
    // The file holds sealed secrets and password hashes (ruling 22 of the plan 12g lane, m2).
    // SQLite alone makes a new file with mode 0644 at the umask 022 of a shell.
    expect(migrateFile().status).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const other = join(dir, "kept.db");
    writeFileSync(other, "");
    chmodSync(other, 0o640);
    const r = runBin(["migrate", "--target", "sqlite", "--file", other]);
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(other).mode & 0o777).toBe(0o640);
  });

  it("lists the pending files with --dry-run and writes nothing", () => {
    const r = migrateFile(["--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...CORE.map((n) => `would apply ${n}`),
      "version before: none; version after: none",
    ]);
    expect(linesOf(r.stderr)).toContain(`no file at ${file}; a run without --dry-run makes it`);
    // A read with node:sqlite would make the file, so the test reads the file system only.
    expect(existsSync(file)).toBe(false);
  });

  it("reads an existing file with --dry-run and writes nothing", () => {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE app_note (id INTEGER PRIMARY KEY)");
    db.close();
    const before = readFileSync(file);
    const r = migrateFile(["--dry-run", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ before: null, pending: CORE, applied: [] });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(taTables(file)).toEqual([]);
  });

  it("stops on a newer database before any write", () => {
    expect(migrateFile().status).toBe(0);
    const db = new DatabaseSync(file);
    db.exec(readFileSync(join(PKG, "test/fixtures/sqlite/0014_future.sql"), "utf8"));
    const before = db.prepare("SELECT name, applied_at FROM ta_migrations ORDER BY name").all();
    db.close();
    const r = migrateFile();
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe(
      "stopped: the database is at version 14; this CLI knows version 13; use a newer CLI",
    );
    const after = new DatabaseSync(file);
    try {
      expect(
        after.prepare("SELECT name, applied_at FROM ta_migrations ORDER BY name").all(),
      ).toEqual(before);
      expect(before).toHaveLength(14);
      expect(
        after.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").get()?.value,
      ).toBe("14");
    } finally {
      after.close();
    }
  });

  it("takes a libSQL URL from an environment variable and its token from a file", async () => {
    // The server is the CLI's own, so the test empties it first. It fails, never
    // skips, when the server is down: run docker compose up -d libsql-cli.
    const client = createClient({ url: LIBSQL_URL });
    try {
      const rs = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      );
      for (const row of rs.rows) await client.execute(`DROP TABLE "${String(row.name)}"`);
    } catch (e) {
      throw new Error(
        `the CLI libSQL test needs the server at ${LIBSQL_URL}: ${(e as Error).message}. Run: docker compose up -d libsql-cli`,
      );
    }
    const token = "libsql-token-canary-0123456789";
    const query = "query-canary-9876543210";
    writeFileSync(join(dir, "token"), `${token}\n`);
    const r = runBin(
      [
        "migrate",
        "--target",
        "sqlite",
        "--url-env",
        "LIBSQL_URL",
        "--auth-token-file",
        join(dir, "token"),
        "--json",
      ],
      { env: { LIBSQL_URL: `${LIBSQL_URL}?authToken=${query}` } },
    );
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ before: null, after: 13, applied: CORE });
      expect(linesOf(r.stderr)[0]).toBe(`connecting to ${LIBSQL_URL.replace(/^\w+:\/\//, "")}`);
      for (const line of [...linesOf(r.stdout), ...linesOf(r.stderr)]) {
        expect(line).not.toContain(token);
        expect(line).not.toContain(query);
      }
      const rs = await client.execute("SELECT value FROM ta_meta WHERE key = 'schema_version'");
      expect(rs.rows[0]?.value).toBe("13");
    } finally {
      client.close();
    }
  });

  it("refuses --file with a URL flag", () => {
    const r = runBin(["migrate", "--target", "sqlite", "--file", file, "--url-env", "LIBSQL_URL"], {
      env: { LIBSQL_URL },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr)[0]).toBe("give --file or --url-env or --url-file, not two");
    expect(taTables(file)).toEqual([]);
  });
});

describe("authtempo check --target sqlite (plan 12g Task 6)", () => {
  const result = (r: CheckReport, id: CheckId) => r.checks.find((c) => c.id === id);

  it("check reads the version and the shape of a SQLite file", async () => {
    expect(migrateFile().status).toBe(0);
    const io = fakeIo({ fetch: deployment(healthy()) });
    const code = await main(["check", BASE, "--target", "sqlite", "--file", file, "--json"], io);
    expect(code, io.stderr.join("\n")).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const report = JSON.parse(io.stdout[0] ?? "") as CheckReport;
    expect(result(report, "schema_version")).toEqual({
      id: "schema_version",
      status: "pass",
      code: null,
      detail: "the database is at version 13",
    });
    expect(result(report, "schema_shape")).toEqual({
      id: "schema_shape",
      status: "pass",
      code: null,
      detail: "each table of the adapter's migrations has its columns, its keys, and its indexes",
    });
    expect(report.warnings).toEqual([]);
    expect(io.stderr).toContain(`opening ${file}`);
  });

  it("check opens the file read-only and makes no file", async () => {
    const io = fakeIo({ fetch: deployment(healthy()) });
    const code = await main(["check", BASE, "--target", "sqlite", "--file", file], io);
    expect(code).toBe(2);
    expect(io.stderr.at(-1)).toBe(`stopped: storage: ERR_SQLITE_ERROR at ${file}`);
    expect(existsSync(file)).toBe(false);
  });
});
