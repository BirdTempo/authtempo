import { DatabaseSync } from "node:sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { afterEach, describe } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { accountDeleteCascadeSuite } from "../account-delete-cascade-suite.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";

// Ruling 13 of plan 12f2 and decision 3 of plan 12o on the SQLite storage of
// the Better Auth tables, through node:sqlite. The tables are Better Auth's
// own SQLite SQL with its foreign keys on. Each test has its own database.

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("the account delete on the compat SQLite storage (ruling 13 of plan 12f2)", () => {
  accountDeleteCascadeSuite(async () => {
    const db = new DatabaseSync(":memory:");
    closers.push(() => db.close());
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(BETTER_AUTH_SQLITE);
    const database = betterAuthSchemaStorage({ dialect: "sqlite", driver: nodeSqlite(db) });
    await database.migrate();
    return {
      database,
      act: () => ({ storage: database.storage, queries: () => null }),
      removeSolo: "removed",
    };
  });
});
