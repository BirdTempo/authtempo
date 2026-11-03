// @ts-expect-error: bun:sqlite has its types in @types/bun, which this package does not take.
import { Database } from "bun:sqlite";
import { bunSqlite } from "@authtempo/adapter-sqlite/bun";
import { sqliteCompatSuite } from "../suite.js";

// The Better Auth tables on bun:sqlite (plan 12n). It runs under the Bun
// runtime only (vitest.bun.config.ts). Each open makes a new `:memory:`
// database, as the node run does.
await sqliteCompatSuite("bun:sqlite", () => {
  const db = new Database(":memory:");
  return {
    driver: bunSqlite(db),
    exec: async (text) => {
      db.run(text);
    },
    close: () => db.close(),
  };
});
