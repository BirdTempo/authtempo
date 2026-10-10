import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import shipped from "../migrations/d1/0001_compat_better_auth.sql?raw";
import shippedBefore17 from "../migrations/d1-before-1.7/0001_compat_better_auth.sql?raw";
import { compatMigrationSql } from "../src/storage/migration.js";
import { resolveNames } from "../src/storage/names.js";
import { BETTER_AUTH_SQLITE } from "./fixtures.js";

/** Better Auth 1.7.2's SQLite schema, in node:sqlite with foreign keys on. */
function sqlite(schema: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schema);
  return db;
}

/** The same schema as a table from before Better Auth 1.7: no issuer column and no index on it. */
const before17 = (schema: string) =>
  schema
    .replace('"issuer" text not null, ', "")
    .replace(/create unique index "account_issuer_accountId_uidx"[^;]*;/, "");

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
      const created = [
        ...compatMigrationSql(dialect, resolveNames()).matchAll(/CREATE TABLE (\w+)/g),
      ].map((m) => m[1]);
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
});
