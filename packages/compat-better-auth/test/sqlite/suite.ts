import { readFileSync } from "node:fs";
import type { SqliteDriver } from "@authtempo/adapter-sqlite";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import type { SqliteVariant } from "../../src/storage/migration.js";
import { before17 } from "../d1/sql.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { at, eq, mappingCases } from "../mapping-cases.js";

/** One SQLite database that a test opened through one driver entry. */
export interface OpenSqlite {
  driver: SqliteDriver;
  /** Runs a SQL text of one or more statements on the handle. */
  exec(text: string): void;
  close(): void;
}

/** The compat migration names in order, typed here so that a change of the list fails a test. */
const ALL_NAMES = [
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

const shippedD1 = (name: string) =>
  readFileSync(new URL(`../../migrations/d1/${name}.sql`, import.meta.url), "utf8");

/** A new memory database through the driver, with foreign keys on, that holds `schema`. */
function withSchema(open: () => OpenSqlite, schema: string): OpenSqlite {
  const db = open();
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schema);
  return db;
}

const user = (id: string, email: string) => ({
  id,
  email,
  emailVerified: true,
  name: null,
  image: null,
  bannedAt: null,
  banReason: null,
  banUntil: null,
  createdAt: at,
  updatedAt: at,
});

const metaRows = async (db: OpenSqlite) =>
  (await db.driver.db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).results;

/**
 * The Better Auth tables on SQLite through one driver (plan 12g Task 8). The
 * tables are Better Auth 1.7.2's own SQLite schema with its seven foreign
 * keys. `migrate()` applies the compat migrations. Then the suite runs the D1
 * mapping cases and core's conformance suite. It also runs the tests of the
 * SQLite runner and of readiness. `open` opens a new memory database, as an
 * app opens its file.
 */
export async function sqliteCompatSuite(kind: string, open: () => OpenSqlite): Promise<void> {
  const main = withSchema(open, BETTER_AUTH_SQLITE);
  const compat = (variant?: SqliteVariant) =>
    betterAuthSchemaStorage({
      dialect: "sqlite",
      driver: main.driver,
      ...(variant ? { variant } : {}),
    });
  const firstRun = await compat().migrate();

  mappingCases(
    { conformance: `compat sqlite ${kind}`, mapping: `the Better Auth mapping on SQLite, ${kind}` },
    {},
    main.driver.db,
    () => compat().storage,
  );

  describe(`the Better Auth storage on SQLite, ${kind}`, () => {
    it("applies the compat migrations once", async () => {
      expect(firstRun).toEqual(ALL_NAMES);
      expect(await compat().migrate()).toEqual([]);
      expect(await metaRows(main)).toEqual([
        { key: "compat_better_auth", value: "10" },
        { key: "schema_version", value: "13" },
      ]);
      const record = await main.driver.db.prepare("SELECT name FROM ta_migrations").all();
      expect(record.results.map((r) => r.name)).toEqual(ALL_NAMES);
    });

    it("reads Better Auth's own dates", async () => {
      // Better Auth writes a date as ISO text; SQLite's own form has no T and no zone.
      main.exec(
        `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('ba-u','Bea','bea@example.com',1,NULL,'2026-09-01T00:00:00.000Z','2026-09-07 10:11:12')`,
      );
      try {
        const raw = await main.driver.db
          .prepare(`SELECT "createdAt", "updatedAt" FROM "user" WHERE "id" = 'ba-u'`)
          .first();
        // The text that D1 answers for the same row: the stored text, unchanged.
        expect(raw).toEqual({
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-07 10:11:12",
        });
        const row = await compat().storage.findOne("user", [eq("id", "ba-u")]);
        expect(row?.createdAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
        expect(row?.updatedAt).toEqual(new Date("2026-09-07T10:11:12.000Z"));
      } finally {
        main.exec(`DELETE FROM "user" WHERE "id" = 'ba-u'`);
      }
    });

    it("counts only the rows of the delete when the foreign keys delete more, as D1 does", async () => {
      // Better Auth's session and account rows name the user with ON DELETE CASCADE.
      const s = compat().storage;
      for (const id of ["u1", "u2"]) {
        await s.create("user", user(id, `${id}@example.com`));
        for (const n of [1, 2])
          await s.create("session", {
            id: `${id}-s${n}`,
            userId: id,
            tokenHash: `h-${id}-${n}`,
            expiresAt: new Date(at.getTime() + 86_400_000),
            lastSeenAt: at,
            ip: null,
            userAgent: null,
            activeOrganizationId: null,
            freshAt: at,
            actorId: null,
            activeTeamId: null,
            createdAt: at,
            updatedAt: at,
          });
      }
      const sessions = async () =>
        (await main.driver.db.prepare(`SELECT count(*) AS n FROM "session"`).first("n")) as number;
      expect(await sessions()).toBe(4);
      expect(await s.delete("user", [eq("id", "u1")])).toBe(1);
      expect(await sessions()).toBe(2);
      expect(await s.transaction((tx) => tx.delete("user", [eq("id", "u2")]))).toBe(1);
      expect(await sessions()).toBe(0);
    });

    it("refuses every call with schema_mismatch while account has no unique index on (issuer, accountId)", async () => {
      main.exec('DROP INDEX "account_issuer_accountId_uidx"');
      try {
        await expect(compat().storage.findOne("user", [eq("id", "x")])).rejects.toMatchObject({
          code: "schema_mismatch",
          model: "identity",
          message: expect.stringMatching(/no unique index on account \(issuer, accountId\)/),
        });
      } finally {
        main.exec(
          'CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")',
        );
      }
      await expect(compat().storage.findOne("user", [eq("id", "x")])).resolves.toBeNull();
    });

    it("applies the before-1.7 files with variant before-1.7", async () => {
      const old = withSchema(open, before17(BETTER_AUTH_SQLITE));
      try {
        const s = betterAuthSchemaStorage({
          dialect: "sqlite",
          driver: old.driver,
          variant: "before-1.7",
        });
        expect(await s.migrate()).toEqual(ALL_NAMES);
        const cols = await old.driver.db
          .prepare("SELECT name FROM pragma_table_info('account')")
          .all();
        expect(cols.results.map((c) => c.name)).toContain("issuer");
        expect(
          await old.driver.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_account__issuer__account_id'",
            )
            .first("name"),
        ).toBe("ux_account__issuer__account_id");
        expect(await metaRows(old)).toEqual([
          { key: "compat_better_auth", value: "10" },
          { key: "schema_version", value: "13" },
        ]);
        // The two 0010 variants make other team tables (12g fix wave, ledger
        // line 49). "before-1.7" makes them in the 1.4.21 form, then adds
        // memberCount with a default and a named unique index. "1.7" makes
        // the 1.7 form, with no default and no such index.
        const memberCount = await old.driver.db
          .prepare(
            `SELECT type, "notnull" AS nn, dflt_value AS d FROM pragma_table_info('team') WHERE name = 'memberCount'`,
          )
          .first();
        expect(memberCount).toEqual({ type: "INTEGER", nn: 1, d: "0" });
        expect(
          await old.driver.db
            .prepare(
              "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'ux_team_member__membership_key'",
            )
            .first("tbl_name"),
        ).toBe("teamMember");
        await expect(s.storage.findOne("user", [eq("id", "x")])).resolves.toBeNull();
      } finally {
        old.close();
      }
    });

    it("skips the migrations that ta_meta already records", async () => {
      // As the D1 flow leaves a database: the first two files, version 2 in ta_meta, no ta_migrations.
      const d1Flow = withSchema(open, BETTER_AUTH_SQLITE);
      try {
        d1Flow.exec(shippedD1("0001_compat_better_auth"));
        d1Flow.exec(shippedD1("0002_compat_schema_v5"));
        const s = betterAuthSchemaStorage({ dialect: "sqlite", driver: d1Flow.driver });
        expect(await s.migrate()).toEqual(ALL_NAMES.slice(2));
        expect(await metaRows(d1Flow)).toEqual([
          { key: "compat_better_auth", value: "10" },
          { key: "schema_version", value: "13" },
        ]);
        await expect(s.storage.findOne("user", [eq("id", "x")])).resolves.toBeNull();
      } finally {
        d1Flow.close();
      }
    });
  });
}
