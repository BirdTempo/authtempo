import { afterEach, describe } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { accountDeleteCascadeSuite } from "./account-delete-cascade-suite.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";

// Ruling 13 of plan 12f2 on the Postgres storage of the Better Auth tables,
// with Better Auth's own SQL and its foreign keys. Each test has its own schema.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("the account delete on the compat Postgres storage (ruling 13 of plan 12f2)", () => {
  accountDeleteCascadeSuite(async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    closers.push(() => pg.close());
    const database = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await migrateWithoutLock(pg.sql, database.names);
    return {
      database,
      act: () => ({ storage: database.storage, queries: () => null }),
      removeSolo: "removed",
      // Run of 2026-11-04: one sweep of 50 calls writes 28 of the 40 owed stop rows.
      sweepStops: 28,
    };
  });
});
