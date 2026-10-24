import { MYSQL_MIGRATIONS } from "@authtempo/adapter-mysql";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckId, CheckReport } from "../src/checks.js";
import { main } from "../src/main.js";
import { SCHEMA_VERSION } from "../src/version.js";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import { BASE, deployment, healthy } from "./support/deployment.js";
import { fakeIo } from "./support/fake-io.js";
import { freshMysqlDatabase, MYSQL_SERVERS } from "./support/mysql.js";

// `authtempo migrate --target mysql` and `check --target mysql` (plan 12g
// Task 6), on both servers of docker-compose.yml. Each test has its own
// database and its own user, so a test can look for the user and the
// password in each output line.

/**
 * The MySQL migrations, typed here: the baseline of adapter-mysql at version
 * 13, the file of version 14 (plan 12d), and the file of version 15 (plan 12i).
 */
const CORE = ["0001_schema_v13", "0002_schema_v14", "0003_schema_v15"];

beforeAll(() => {
  assertFreshBuild();
});

describe.each(MYSQL_SERVERS)(
  "authtempo migrate --target mysql on MySQL $version (plan 12g Task 6)",
  (server) => {
    let db: Awaited<ReturnType<typeof freshMysqlDatabase>>;
    beforeEach(async () => {
      db = await freshMysqlDatabase(server);
    });
    afterEach(async () => {
      await db.drop();
    });

    const migrate = (extra: string[], url = db.url) =>
      runBin(["migrate", "--target", "mysql", "--url-env", "MYSQL_URL", ...extra], {
        env: { MYSQL_URL: url },
      });

    it("migrates an empty database and reaches the CLI's version", () => {
      const r = migrate(["--json"]);
      expect(r.status, r.stderr).toBe(0);
      const doc = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(doc).toEqual({
        target: "mysql",
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
      const again = migrate(["--json"]);
      expect(again.status, again.stderr).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({
        before: 15,
        after: 15,
        pending: [],
        applied: [],
      });
    });

    it("names the database by host, port, and name only", () => {
      for (const r of [migrate([]), migrate(["--dry-run"]), migrate(["--json"])]) {
        expect(r.status, r.stderr).toBe(0);
        expect(linesOf(r.stderr)).toContain(`connecting to ${db.host}/${db.name}`);
        for (const line of [...linesOf(r.stdout), ...linesOf(r.stderr)]) {
          expect(line).not.toContain(db.password);
          expect(line).not.toContain(db.user);
        }
      }
    });

    it("prints the code of a driver error, not its message", async () => {
      const r = migrate([], db.urlWithPassword("wrong-password-canary"));
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(linesOf(r.stderr).at(-1)).toBe(
        `stopped: storage: ER_ACCESS_DENIED_ERROR at ${db.host}/${db.name}; nothing was written`,
      );
      for (const line of linesOf(r.stderr)) {
        expect(line).not.toContain(db.user);
        expect(line).not.toContain("wrong-password-canary");
      }
      expect(await db.query(`SHOW TABLES FROM \`${db.name}\``)).toEqual([]);
    });

    it("refuses --tables compat on mysql", async () => {
      const r = migrate(["--tables", "compat"]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(linesOf(r.stderr)[0]).toBe(
        "--tables compat is not served on mysql (plan 12g, owner decision 4)",
      );
      expect(await db.query(`SHOW TABLES FROM \`${db.name}\``)).toEqual([]);
    });

    it("counts a migration with part of its steps recorded as pending, and resumes it", async () => {
      // The runner records each step after it runs (adapter-mysql
      // migrateSteps). A run killed after step `half` leaves this state.
      const steps = MYSQL_MIGRATIONS[0]?.statements ?? [];
      const half = Math.floor(steps.length / 2);
      expect(half).toBeGreaterThan(0);
      const conn = await mysql.createConnection({ uri: db.url });
      try {
        await conn.query(
          "CREATE TABLE IF NOT EXISTS `ta_migrations` (`name` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `step` INT NOT NULL, `applied_at` BIGINT NOT NULL, PRIMARY KEY (`name`, `step`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
        );
        for (const [i, sql] of steps.slice(0, half).entries()) {
          await conn.query(sql);
          await conn.execute(
            "INSERT INTO `ta_migrations` (`name`, `step`, `applied_at`) VALUES (?, ?, ?)",
            ["0001_schema_v13", i + 1, Date.now()],
          );
        }
      } finally {
        await conn.end();
      }
      const dry = migrate(["--dry-run", "--json"]);
      expect(dry.status, dry.stderr).toBe(0);
      expect(JSON.parse(dry.stdout)).toMatchObject({ before: null, pending: CORE, applied: [] });
      const r = migrate(["--json"]);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        before: null,
        after: 15,
        pending: CORE,
        applied: CORE,
      });
      const rows = (await db.query(
        `SELECT COUNT(*) AS n FROM \`${db.name}\`.\`ta_migrations\``,
      )) as RowDataPacket[];
      // Every step of every file: the run resumed the baseline and applied 0002.
      expect(Number(rows[0]?.n)).toBe(MYSQL_MIGRATIONS.flatMap((m) => m.statements).length);
    });

    it("check reports schema_shape on MySQL", async () => {
      expect(migrate([]).status).toBe(0);
      const io = fakeIo({ env: { MYSQL_URL: db.url }, fetch: deployment(healthy()) });
      const code = await main(
        ["check", BASE, "--target", "mysql", "--url-env", "MYSQL_URL", "--json"],
        io,
      );
      expect(code, io.stderr.join("\n")).toBe(0);
      expect(io.stdout).toHaveLength(1);
      const report = JSON.parse(io.stdout[0] ?? "") as CheckReport;
      const result = (id: CheckId) => report.checks.find((c) => c.id === id);
      expect(result("schema_version")).toEqual({
        id: "schema_version",
        status: "pass",
        code: null,
        detail: "the database is at version 15",
      });
      expect(result("schema_shape")).toEqual({
        id: "schema_shape",
        status: "pass",
        code: null,
        detail: "each table of the adapter's migrations has its columns, its keys, and its indexes",
      });
      expect(report.warnings).toEqual([]);
      expect(io.stderr).toContain(`connecting to ${db.host}/${db.name}`);
      for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(db.password);
    });
  },
);

describe("authtempo migrate --target mysql with no TLS (plan 12g Review Focus 5)", () => {
  it("stops a remote host with no TLS before any connection, and prints no password", () => {
    const r = runBin(["migrate", "--target", "mysql", "--url-env", "DB"], {
      env: { DB: "mysql://u:s3cr3t@db.example.com:3306/app" },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const lines = linesOf(r.stderr);
    expect(lines).toEqual([
      'stopped: db.example.com:3306/app is not a loopback host, and the URL asks for no TLS with certificate and host name checks; add ?ssl={"rejectUnauthorized":true,"verifyIdentity":true}',
    ]);
    for (const line of lines) expect(line).not.toContain("s3cr3t");
  });

  it("refuses a query key that the CLI does not take, before mysql2 reads it", () => {
    // mysql2 prints an unknown key with console.error, past the scrub list.
    const r = runBin(["migrate", "--target", "mysql", "--url-env", "DB"], {
      env: { DB: "mysql://u:s3cr3t@127.0.0.1:9/app?s3cr3tkey=1" },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr)).toEqual([
      "stopped: the connection string of mysql has a query key that the CLI does not take; it takes ssl, connectTimeout",
    ]);
  });
});
