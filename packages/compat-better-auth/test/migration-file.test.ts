import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "@authtempo/adapter-postgres";
import { columnsOf, TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import core0011D1 from "../../adapter-d1/migrations/0011_schema_v11.sql?raw";
import shipped from "../migrations/d1/0001_compat_better_auth.sql?raw";
import shipped0002 from "../migrations/d1/0002_compat_schema_v5.sql?raw";
import shipped0003 from "../migrations/d1/0003_compat_schema_v6.sql?raw";
import shipped0004 from "../migrations/d1/0004_compat_schema_v7.sql?raw";
import shipped0005 from "../migrations/d1/0005_compat_schema_v8.sql?raw";
import shipped0006 from "../migrations/d1/0006_compat_schema_v9.sql?raw";
import shipped0007 from "../migrations/d1/0007_compat_schema_v10.sql?raw";
import shipped0008 from "../migrations/d1/0008_compat_schema_v11.sql?raw";
import shippedBefore17 from "../migrations/d1-before-1.7/0001_compat_better_auth.sql?raw";
import shipped0002Before17 from "../migrations/d1-before-1.7/0002_compat_schema_v5.sql?raw";
import shipped0003Before17 from "../migrations/d1-before-1.7/0003_compat_schema_v6.sql?raw";
import shipped0004Before17 from "../migrations/d1-before-1.7/0004_compat_schema_v7.sql?raw";
import shipped0005Before17 from "../migrations/d1-before-1.7/0005_compat_schema_v8.sql?raw";
import shipped0006Before17 from "../migrations/d1-before-1.7/0006_compat_schema_v9.sql?raw";
import shipped0007Before17 from "../migrations/d1-before-1.7/0007_compat_schema_v10.sql?raw";
import shipped0008Before17 from "../migrations/d1-before-1.7/0008_compat_schema_v11.sql?raw";
import {
  COMPAT_MIGRATION_0002_SQL,
  COMPAT_MIGRATION_0003_SQL,
  COMPAT_MIGRATION_0004_SQL,
  COMPAT_MIGRATION_0005_SQL,
  COMPAT_MIGRATION_NAMES,
  compatMigration0006Sql,
  compatMigration0007Sql,
  compatMigration0008Sql,
  compatMigrationSql,
  MIGRATION_0007_NAME,
  MIGRATION_0008_NAME,
} from "../src/storage/migration.js";
import { resolveNames } from "../src/storage/names.js";
import { before17 } from "./d1/sql.js";
import { BETTER_AUTH_SQLITE } from "./fixtures.js";

/** Better Auth 1.7.2's SQLite schema, in node:sqlite with foreign keys on. */
function sqlite(schema: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schema);
  return db;
}

/**
 * The columns of a model before schema version 9. Migration 0006 (plan 12b)
 * adds secret_version last to ta_totp, ta_second_factor, and ta_jwk, so a
 * test of an earlier migration holds the table to the columns it had then.
 */
const columnsBefore9 = (model: Parameters<typeof columnsOf>[0]) =>
  columnsBefore11(model).filter((c) => c !== "secret_version");

/**
 * The columns of a model before schema version 11. Migration 0008 (plan 12e)
 * adds its columns last to ta_oauth_client and ta_oauth_token.
 */
const ADDED_IN_11: ReadonlySet<string> = new Set([
  "auth_method",
  "secret_hash",
  "secret_expires_at",
  "previous_secret_hash",
  "previous_secret_until",
  "jwks",
  "jwks_uri",
  "grant_types",
  "credentials_scopes",
  "introspect",
  "post_logout_redirect_uris",
  "backchannel_logout_uri",
  "backchannel_logout_session_required",
  "subject_type",
  "dpop_bound",
  "parent_id",
  "dpop_jkt",
]);
const columnsBefore11 = (model: Parameters<typeof columnsOf>[0]) =>
  model === "oauthClient" || model === "oauthToken"
    ? columnsOf(model).filter((c) => !ADDED_IN_11.has(c))
    : columnsOf(model);

/** The ta tables in the database, by name. */
const taTables = (db: DatabaseSync) =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

/** The unique indexes on account over exactly issuer and accountId, by name. */
function issuerIndexes(db: DatabaseSync): string[] {
  const list = db.prepare(`PRAGMA index_list("account")`).all() as {
    name: string;
    unique: number;
  }[];
  return list
    .filter((i) => i.unique === 1)
    .filter((i) => {
      const cols = (db.prepare(`PRAGMA index_info("${i.name}")`).all() as { name: string }[])
        .map((c) => c.name)
        .sort();
      return cols.join(",") === "accountId,issuer";
    })
    .map((i) => i.name);
}

const SEED = `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u','U','u@example.com',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');`;
const account = (id: string, accountId: string, providerId: string, issuer?: string) =>
  `INSERT INTO "account" ("id",${issuer ? '"issuer",' : ""}"accountId","providerId","userId","createdAt","updatedAt") VALUES ('${id}',${issuer ? `'${issuer}',` : ""}'${accountId}','${providerId}','u','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');`;

const normalize = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

describe("migration 0001", () => {
  it("ships both D1 files as the generator's text for the default names (one source)", () => {
    expect(normalize(shipped)).toBe(normalize(compatMigrationSql("sqlite", resolveNames())));
    expect(normalize(shippedBefore17)).toBe(
      normalize(compatMigrationSql("sqlite", resolveNames(), "before-1.7")),
    );
  });

  it("runs the 1.7 file on Better Auth 1.7 tables and makes no second issuer index", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(SEED + account("a1", "u", "credential", "local:credential"));
    db.exec(shipped);
    expect(issuerIndexes(db)).toEqual(["account_issuer_accountId_uidx"]);
    expect(db.prepare(`SELECT value FROM ta_meta WHERE key = 'compat_better_auth'`).get()).toEqual({
      value: "1",
    });
  });

  it("runs the before-1.7 file on tables with no issuer: adds, fills, and keys it", () => {
    const db = sqlite(before17(BETTER_AUTH_SQLITE));
    db.exec(SEED + account("a1", "u", "credential") + account("a2", "g-sub", "google"));
    db.exec(shippedBefore17);
    expect(db.prepare(`SELECT "id", "issuer" FROM "account" ORDER BY "id"`).all()).toEqual([
      { id: "a1", issuer: "local:credential" },
      { id: "a2", issuer: "https://accounts.google.com" },
    ]);
    expect(issuerIndexes(db)).toEqual(["ux_account__issuer__account_id"]);
    expect(() => db.exec(account("a3", "g-sub", "google", "https://accounts.google.com"))).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("creates no table other than ta_limit and ta_meta, on both dialects", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      // A table the same text drops again (the SQLite date check) is not kept.
      const text = compatMigrationSql(dialect, resolveNames());
      const dropped = new Set([...text.matchAll(/DROP TABLE (\w+)/g)].map((m) => m[1]));
      const created = [...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)]
        .map((m) => m[1])
        .filter((t) => !dropped.has(t));
      expect({ dialect, created: created.sort() }).toEqual({
        dialect,
        created: ["ta_limit", "ta_meta"],
      });
    }
  });

  it("writes the version rows last, so a failed run leaves no version", () => {
    const lines = compatMigrationSql("sqlite", resolveNames()).trim().split("\n");
    expect(lines.at(-1)).toBe(
      "INSERT INTO ta_meta (key, value) VALUES ('schema_version', '4'), ('compat_better_auth', '1');",
    );
  });

  it("refuses the 1.7 file on tables from before 1.7 with 'no such column: issuer' and keeps no ta table (M-1)", () => {
    const db = sqlite(before17(BETTER_AUTH_SQLITE));
    db.exec(SEED + account("a1", "u", "credential"));
    expect(() => db.exec(shipped)).toThrow(/no such column: issuer/);
    expect(taTables(db)).toEqual([]);
  });

  it("refuses the before-1.7 file on 1.7 tables with 'duplicate column name: issuer' and keeps no ta table (M-1)", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(SEED + account("a1", "u", "credential", "local:credential"));
    expect(() => db.exec(shippedBefore17)).toThrow(/duplicate column name: issuer/);
    expect(taTables(db)).toEqual([]);
  });

  it("refuses a second run with 'table ta_limit already exists' and changes nothing (M-1)", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(SEED + account("a1", "u", "credential", "local:credential"));
    db.exec(shipped);
    const before = db.prepare(`SELECT * FROM "account"`).all();
    expect(() => db.exec(shipped)).toThrow(/table ta_limit already exists/);
    expect(taTables(db)).toEqual(["ta_limit", "ta_meta"]);
    expect(db.prepare(`SELECT * FROM "account"`).all()).toEqual(before);
  });

  it("refuses an integer Better Auth date before it adds a ta table (I-3)", () => {
    for (const [schema, file] of [
      [BETTER_AUTH_SQLITE, shipped],
      [before17(BETTER_AUTH_SQLITE), shippedBefore17],
    ] as const) {
      const db = sqlite(schema);
      // A Drizzle schema with integer({ mode: "timestamp_ms" }) stores a number.
      db.exec(
        `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u','U','u@example.com',1,1757240000000,'2026-09-01T00:00:00.000Z');`,
      );
      expect(() => db.exec(file)).toThrow(
        /CHECK constraint failed: tempo_auth_compat_every_better_auth_date_must_be_text/,
      );
      // node:sqlite exec does not roll back: only the empty check table is left.
      expect(taTables(db)).toEqual(["ta_date_check"]);
    }
  });

  it("fills the added dates as ISO millisecond text, also from SQLite's 'YYYY-MM-DD HH:MM:SS' form", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(`${SEED}
      INSERT INTO "organization" ("id","name","slug","createdAt") VALUES ('o1','O','o','2026-09-07 10:11:12');
      INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId") VALUES ('s1','2026-12-01T00:00:00.000Z','t','2026-09-05 00:00:00','2026-09-06T01:02:03.456Z','u');`);
    db.exec(shipped);
    expect(db.prepare(`SELECT "taUpdatedAt" AS v FROM "organization"`).get()).toEqual({
      v: "2026-09-07T10:11:12.000Z",
    });
    expect(db.prepare(`SELECT "taLastSeenAt" AS v FROM "session"`).get()).toEqual({
      v: "2026-09-06T01:02:03.456Z",
    });
    expect(db.prepare(`SELECT "taUpdatedAt" AS v FROM "member"`).all()).toEqual([]);
  });
});

describe("migration 0002 (plan 8b)", () => {
  it("ships both D1 files as the one constant's text", () => {
    expect(normalize(shipped0002)).toBe(normalize(COMPAT_MIGRATION_0002_SQL));
    expect(normalize(shipped0002Before17)).toBe(normalize(COMPAT_MIGRATION_0002_SQL));
  });

  it("moves the stored versions after 0001 on Better Auth 1.7 tables", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(shipped);
    db.exec(shipped0002);
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "2" },
      { key: "schema_version", value: "5" },
    ]);
  });
});

describe("migration 0003 (plan 9f)", () => {
  it("ships both D1 files as the one constant's SQLite text", () => {
    expect(normalize(shipped0003)).toBe(normalize(COMPAT_MIGRATION_0003_SQL.sqlite));
    expect(normalize(shipped0003Before17)).toBe(normalize(COMPAT_MIGRATION_0003_SQL.sqlite));
  });

  it("creates core's two tables with core's columns in order, and moves the versions to 6 and 3", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(shipped);
    db.exec(shipped0002);
    db.exec(shipped0003);
    expect(taTables(db)).toEqual(["ta_limit", "ta_meta", "ta_totp", "ta_trusted_device"]);
    for (const model of ["totp", "trustedDevice"] as const) {
      const cols = (
        db.prepare(`PRAGMA table_info(${TABLES[model]})`).all() as { name: string }[]
      ).map((c) => c.name);
      expect({ model, cols }).toEqual({ model, cols: columnsBefore9(model) });
    }
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "3" },
      { key: "schema_version", value: "6" },
    ]);
  });
});

describe("migration 0004 (plan 9g)", () => {
  it("ships both D1 files as the one constant's SQLite text", () => {
    expect(normalize(shipped0004)).toBe(normalize(COMPAT_MIGRATION_0004_SQL.sqlite));
    expect(normalize(shipped0004Before17)).toBe(normalize(COMPAT_MIGRATION_0004_SQL.sqlite));
  });

  it("creates core's four tables with core's columns in order, and moves the versions to 7 and 4", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(shipped);
    db.exec(shipped0002);
    db.exec(shipped0003);
    db.exec(shipped0004);
    expect(taTables(db)).toEqual([
      "ta_jwk",
      "ta_limit",
      "ta_meta",
      "ta_oauth_client",
      "ta_oauth_consent",
      "ta_oauth_token",
      "ta_totp",
      "ta_trusted_device",
    ]);
    for (const model of ["jwk", "oauthClient", "oauthConsent", "oauthToken"] as const) {
      const cols = (
        db.prepare(`PRAGMA table_info(${TABLES[model]})`).all() as { name: string }[]
      ).map((c) => c.name);
      expect({ model, cols }).toEqual({ model, cols: columnsBefore9(model) });
    }
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "4" },
      { key: "schema_version", value: "7" },
    ]);
  });
});

describe("migration 0005 (plan 12c)", () => {
  it("ships both D1 files as the one constant's SQLite text", () => {
    expect(normalize(shipped0005)).toBe(normalize(COMPAT_MIGRATION_0005_SQL.sqlite));
    expect(normalize(shipped0005Before17)).toBe(normalize(COMPAT_MIGRATION_0005_SQL.sqlite));
    // No file holds the Postgres text, so this line holds it to the totp cleanup.
    expect(COMPAT_MIGRATION_0005_SQL.postgres).toContain(
      "DELETE FROM ta_totp WHERE enabled_at IS NULL;",
    );
  });

  it("creates core's table with core's columns, copies the enabled totp rows, and moves the versions to 8 and 5", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    db.exec(shipped);
    db.exec(shipped0002);
    db.exec(shipped0003);
    db.exec(shipped0004);
    db.exec(
      `INSERT INTO ta_totp (id, created_at, updated_at, user_id, secret, enabled_at, last_step, backup_codes)
       VALUES ('f1', 1, 2, 'u1', 'sealed', 3, 5, '["h1"]'), ('f2', 1, 2, 'u2', 'sealed', NULL, 0, '["h2"]')`,
    );
    db.exec(shipped0005);
    // The unconfirmed setup f2 holds codes of plan 9f: 0005 deletes it.
    expect(db.prepare("SELECT id FROM ta_totp").all()).toEqual([{ id: "f1" }]);
    expect(taTables(db)).toContain("ta_second_factor");
    const cols = (
      db.prepare(`PRAGMA table_info(${TABLES.secondFactor})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(columnsBefore9("secondFactor"));
    expect(db.prepare("SELECT * FROM ta_second_factor").all()).toEqual([
      {
        id: "f1",
        created_at: 1,
        updated_at: 2,
        user_id: "u1",
        enabled_at: 3,
        methods: '["totp"]',
        backup_codes: '["h1"]',
        backup_codes_version: 1,
      },
    ]);
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "5" },
      { key: "schema_version", value: "8" },
    ]);
  });
});

describe("migration 0006 (plan 12b)", () => {
  it("ships both D1 files as the default naming's SQLite text", () => {
    const text = compatMigration0006Sql("sqlite", resolveNames());
    expect(normalize(shipped0006)).toBe(normalize(text));
    expect(normalize(shipped0006Before17)).toBe(normalize(text));
  });

  it("adds secret_version to core's three tables and taSecretVersion to verification, default 1, and moves the versions to 9 and 6", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    for (const file of [shipped, shipped0002, shipped0003, shipped0004, shipped0005]) db.exec(file);
    db.exec(
      `INSERT INTO "verification" ("id","identifier","value","expiresAt","createdAt","updatedAt") VALUES ('v','i','h','2026-10-14T00:00:00.000Z','2026-10-14T00:00:00.000Z','2026-10-14T00:00:00.000Z');`,
    );
    db.exec(shipped0006);
    for (const model of ["totp", "secondFactor", "jwk"] as const) {
      const cols = (
        db.prepare(`PRAGMA table_info(${TABLES[model]})`).all() as { name: string }[]
      ).map((c) => c.name);
      expect({ model, cols }).toEqual({ model, cols: columnsOf(model) });
    }
    expect(db.prepare(`SELECT "taSecretVersion" AS v FROM "verification"`).all()).toEqual([
      { v: 1 },
    ]);
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "6" },
      { key: "schema_version", value: "9" },
    ]);
  });
});

describe("migration 0007 (plan 12a)", () => {
  it("ships both D1 files as the default naming's SQLite text", () => {
    const text = compatMigration0007Sql("sqlite", resolveNames());
    expect(normalize(shipped0007)).toBe(normalize(text));
    expect(normalize(shipped0007Before17)).toBe(normalize(text));
  });

  it("adds taFreshAt to session with no fill, and moves the versions to 10 and 7", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    // A session of Better Auth from before the files: a fill of 0007 would reach it.
    db.exec(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Ada', 'ada@example.com', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', '2026-11-01T00:00:00.000Z', 't1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'u1')`,
    );
    for (const text of [
      shipped,
      shipped0002,
      shipped0003,
      shipped0004,
      shipped0005,
      shipped0006,
      shipped0007,
    ])
      db.exec(text);
    const cols = db.prepare(`PRAGMA table_info("session")`).all() as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[];
    expect(cols.find((c) => c.name === "taFreshAt")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(db.prepare(`SELECT "taFreshAt" AS f FROM "session" WHERE id = 's1'`).get()).toEqual({
      f: null,
    });
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "7" },
      { key: "schema_version", value: "10" },
    ]);
  });
});

describe("migration 0008 (plan 12e)", () => {
  it("ships both D1 files as the SQLite text of compatMigration0008Sql", () => {
    const text = compatMigration0008Sql("sqlite");
    expect(normalize(shipped0008)).toBe(normalize(text));
    expect(normalize(shipped0008Before17)).toBe(normalize(text));
  });

  it("is the runner's step after 0007, and the step writes '8'", () => {
    const names = [...COMPAT_MIGRATION_NAMES];
    expect(names.indexOf(MIGRATION_0008_NAME)).toBe(names.indexOf(MIGRATION_0007_NAME) + 1);
    expect(MIGRATION_0008_NAME).toBe("0008_compat_schema_v11");
    for (const dialect of ["postgres", "sqlite"] as const)
      expect(compatMigration0008Sql(dialect)).toContain(
        "UPDATE ta_meta SET value = '8' WHERE key = 'compat_better_auth';",
      );
  });

  it("adds core's version 11 columns and tables with their defaults, and moves the versions to 11 and 8", () => {
    const db = sqlite(BETTER_AUTH_SQLITE);
    for (const text of [
      shipped,
      shipped0002,
      shipped0003,
      shipped0004,
      shipped0005,
      shipped0006,
      shipped0007,
    ])
      db.exec(text);
    // A client and a token of version 10, before the file: 0008 must give them the defaults.
    db.exec(
      `INSERT INTO ta_oauth_client (id, created_at, updated_at, kind, name, redirect_uris, last_seen_at) VALUES ('cl_10', 1, 1, 'registered', NULL, '["https://app.example.com/cb"]', 1)`,
    );
    db.exec(
      `INSERT INTO ta_oauth_token (id, created_at, updated_at, token_hash, family_id, user_id, client_id, scopes, resource, expires_at, used_at) VALUES ('t10', 1, 1, 'h10', 'f10', 'u10', 'cl_10', '["offline_access"]', 'https://api.example.com/mcp', 2, NULL)`,
    );
    db.exec(shipped0008);
    for (const model of [
      "oauthClient",
      "oauthToken",
      "oauthDevice",
      "oauthSubject",
      "oauthSessionClient",
      "oauthLogout",
    ] as const) {
      const cols = (
        db.prepare(`PRAGMA table_info(${TABLES[model]})`).all() as { name: string }[]
      ).map((c) => c.name);
      expect({ model, cols }).toEqual({ model, cols: columnsOf(model) });
    }
    expect(
      db
        .prepare(
          "SELECT auth_method, secret_hash, grant_types, credentials_scopes, introspect, post_logout_redirect_uris, backchannel_logout_session_required, subject_type, dpop_bound FROM ta_oauth_client",
        )
        .all(),
    ).toEqual([
      {
        auth_method: "none",
        secret_hash: null,
        grant_types: '["authorization_code","refresh_token"]',
        credentials_scopes: "[]",
        introspect: 0,
        post_logout_redirect_uris: "[]",
        backchannel_logout_session_required: 0,
        subject_type: "public",
        dpop_bound: 0,
      },
    ]);
    expect(db.prepare("SELECT parent_id, dpop_jkt FROM ta_oauth_token").all()).toEqual([
      { parent_id: null, dpop_jkt: null },
    ]);
    expect(db.prepare("SELECT key, value FROM ta_meta ORDER BY key").all()).toEqual([
      { key: "compat_better_auth", value: "8" },
      { key: "schema_version", value: "11" },
    ]);
  });
});

describe("migration 0008 and core 0011 (plan 12e)", () => {
  /** The statements of a text, without comments, blank space, and the ta_meta version writes. */
  const statementsOf = (text: string) =>
    normalize(text)
      .split(";")
      .map((st) => st.trim())
      .filter((st) => st !== "" && !st.startsWith("UPDATE ta_meta"));

  it("holds core 0011's statements on Postgres and on D1, each with its defaults", () => {
    const pg = MIGRATIONS.find((m) => m.name === "0011_schema_v11");
    expect(pg).toBeDefined();
    expect(statementsOf(compatMigration0008Sql("postgres"))).toEqual(statementsOf(pg?.sql ?? ""));
    expect(statementsOf(compatMigration0008Sql("sqlite"))).toEqual(statementsOf(core0011D1));
  });
});
