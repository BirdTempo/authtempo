import { spawnSync } from "node:child_process";
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
import { assertFreshBuild, BIN, linesOf, PKG, runBin } from "./support/bin.js";
import { BASE, deployment, healthy } from "./support/deployment.js";
import { fakeIo } from "./support/fake-io.js";

/** The address of a test server: `node scripts/test-servers.mjs up` writes it, and `pnpm test` passes it. */
function serverUrl(name: string): string {
  const url = process.env[name];
  if (url === undefined || url === "")
    throw new Error(
      `${name} is not set. Run: node scripts/test-servers.mjs up (pnpm test runs it for you)`,
    );
  return url;
}

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
  "0014_schema_v14",
  "0015_schema_v15",
];

/** The CLI's own libSQL server (ruling 1 of plan 12g, map point 15). */
const LIBSQL_URL = serverUrl("AUTHTEMPO_LIBSQL_CLI_URL");

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

/**
 * Puts the file in WAL mode. This connection is the last one, so it deletes
 * the -wal and -shm files when it closes.
 */
function toWal(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
}

/** The two files that SQLite keeps beside a file in WAL mode. */
const WAL_SIDES = ["-wal", "-shm"];

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
      after: 15,
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
      before: 15,
      after: 15,
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

  it("makes a new file with mode 0600 at the umasks 000, 022, 027, and 077", () => {
    // The test above takes the umask of vitest. At umask 077, SQLite alone
    // makes mode 0600, so a shell sets each umask for the child here.
    for (const mask of ["000", "022", "027", "077"]) {
      const path = join(dir, `mask-${mask}.db`);
      const r = spawnSync(
        "/bin/sh",
        [
          "-c",
          'umask "$1"; shift; exec "$@"',
          "sh",
          mask,
          process.execPath,
          BIN,
          "migrate",
          "--target",
          "sqlite",
          "--file",
          path,
        ],
        {
          cwd: PKG,
          encoding: "utf8",
          input: "",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            TMPDIR: process.env.TMPDIR ?? "/tmp",
          },
          timeout: 300_000,
        },
      );
      expect(r.status, `${mask}: ${r.stderr}`).toBe(0);
      expect(statSync(path).mode & 0o777, mask).toBe(0o600);
      // SQLite gives the -wal and -shm files the mode of the main file.
      for (const side of ["-wal", "-shm"])
        if (existsSync(path + side))
          expect(statSync(path + side).mode & 0o777, mask + side).toBe(0o600);
    }
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

  it("keeps the bytes of a file in WAL mode on --dry-run, and leaves its -wal and -shm files", () => {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE app_note (id INTEGER PRIMARY KEY)");
    db.close();
    toWal(file);
    for (const side of WAL_SIDES) expect(existsSync(file + side), side).toBe(false);
    const before = readFileSync(file);
    const r = migrateFile(["--dry-run", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ before: null, pending: CORE, applied: [] });
    expect(readFileSync(file).equals(before)).toBe(true);
    // A read-only connection cannot delete the two files. The CLI deletes
    // neither, because another connection can hold them (migrate.md).
    for (const side of WAL_SIDES) expect(existsSync(file + side), side).toBe(true);
    // taTables opens the file read-write, so it runs after the file checks.
    expect(taTables(file)).toEqual([]);
  });

  it("stops on a newer database before any write", () => {
    expect(migrateFile().status).toBe(0);
    const db = new DatabaseSync(file);
    db.exec(readFileSync(join(PKG, "test/fixtures/sqlite/0016_future.sql"), "utf8"));
    const before = db.prepare("SELECT name, applied_at FROM ta_migrations ORDER BY name").all();
    db.close();
    const r = migrateFile();
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr).at(-1)).toBe(
      "stopped: the database is at version 16; this CLI knows version 15; use a newer CLI",
    );
    const after = new DatabaseSync(file);
    try {
      expect(
        after.prepare("SELECT name, applied_at FROM ta_migrations ORDER BY name").all(),
      ).toEqual(before);
      // The 15 core files and the future fixture.
      expect(before).toHaveLength(16);
      expect(
        after.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").get()?.value,
      ).toBe("16");
    } finally {
      after.close();
    }
  });

  it("stops on a file that is not a SQLite database, and keeps its bytes", () => {
    // node:sqlite reads a file of one byte as an empty database, and a run
    // would write over it (the lead note of the 12g ledger, line 77).
    for (const bytes of ["x", "a note of the app\n", `${"y".repeat(200)}\n`])
      for (const extra of [[], ["--dry-run"]]) {
        writeFileSync(file, bytes);
        const r = migrateFile(extra);
        expect(r.status, `${bytes.length} bytes ${extra.join(" ")}`).toBe(2);
        expect(linesOf(r.stderr).at(-1)).toBe(
          `stopped: ${file} is not a SQLite database: its first bytes are not the SQLite header; nothing was written`,
        );
        expect(readFileSync(file, "utf8")).toBe(bytes);
      }
  });

  it("takes a libSQL URL from an environment variable and its token from a file", async () => {
    // The server is the CLI's own, so the test empties it first. It fails, never
    // skips, when the server is down: run node scripts/test-servers.mjs up.
    const client = createClient({ url: LIBSQL_URL });
    try {
      const rs = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      );
      for (const row of rs.rows) await client.execute(`DROP TABLE "${String(row.name)}"`);
    } catch (e) {
      throw new Error(
        `the CLI libSQL test needs the server at ${LIBSQL_URL}: ${(e as Error).message}. Run: node scripts/test-servers.mjs up`,
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
      expect(JSON.parse(r.stdout)).toMatchObject({ before: null, after: 15, applied: CORE });
      expect(linesOf(r.stderr)[0]).toBe(`connecting to ${LIBSQL_URL.replace(/^\w+:\/\//, "")}`);
      for (const line of [...linesOf(r.stdout), ...linesOf(r.stderr)]) {
        expect(line).not.toContain(token);
        expect(line).not.toContain(query);
      }
      const rs = await client.execute("SELECT value FROM ta_meta WHERE key = 'schema_version'");
      expect(rs.rows[0]?.value).toBe("15");
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
      detail: "the database is at version 15",
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

  it("check keeps the bytes of a file in WAL mode, and leaves its -wal and -shm files", async () => {
    expect(migrateFile().status).toBe(0);
    toWal(file);
    for (const side of WAL_SIDES) expect(existsSync(file + side), side).toBe(false);
    const before = readFileSync(file);
    const io = fakeIo({ fetch: deployment(healthy()) });
    const code = await main(["check", BASE, "--target", "sqlite", "--file", file], io);
    expect(code, io.stderr.join("\n")).toBe(0);
    expect(readFileSync(file).equals(before)).toBe(true);
    // The read-only connection of check leaves both files too (check.md).
    for (const side of WAL_SIDES) expect(existsSync(file + side), side).toBe(true);
  });

  it("check opens the file read-only and makes no file", async () => {
    const io = fakeIo({ fetch: deployment(healthy()) });
    const code = await main(["check", BASE, "--target", "sqlite", "--file", file], io);
    expect(code).toBe(2);
    expect(io.stderr.at(-1)).toBe(`stopped: storage: ERR_SQLITE_ERROR at ${file}`);
    expect(existsSync(file)).toBe(false);
  });
});
