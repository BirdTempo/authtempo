import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { bunSqlite } from "../../src/bun.js";
import { createSqliteAdapter } from "../../src/index.js";
import { runSqliteSuites } from "../support/suite.js";

// Runs under the Bun runtime only (vitest.bun.config.ts). A new `:memory:`
// database for each test.
runSqliteSuites("bun:sqlite", async () => {
  const db = new Database(":memory:");
  return { driver: bunSqlite(db), close: () => db.close() };
});

describe("sqlite runner on bun:sqlite", () => {
  it("refuses a handle that reads integers as BigInt", async () => {
    const db = new Database(":memory:", { safeIntegers: true });
    try {
      const err = await createSqliteAdapter(bunSqlite(db))
        .findMany("user", [])
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "StorageError", code: "config_mismatch" });
      expect((err as Error).message).toContain(
        "the driver reads integers as BigInt; open the database without readBigInts, safeIntegers, or intMode bigint",
      );
    } finally {
      db.close();
    }
  });
});
