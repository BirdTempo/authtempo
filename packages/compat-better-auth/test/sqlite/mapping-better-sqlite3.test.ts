import { betterSqlite3 } from "@authtempo/adapter-sqlite/better-sqlite3";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { eq } from "../mapping-cases.js";
import { sqliteCompatSuite } from "./suite.js";

await sqliteCompatSuite("better-sqlite3", () => {
  const db = new Database(":memory:");
  return {
    driver: betterSqlite3(db),
    exec: async (text) => {
      db.exec(text);
    },
    close: () => db.close(),
  };
});

it("refuses a better-sqlite3 handle that reads integers as BigInt with config_mismatch", async () => {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  try {
    const s = betterAuthSchemaStorage({ dialect: "sqlite", driver: betterSqlite3(db) });
    await expect(s.storage.findOne("user", [eq("id", "x")])).rejects.toMatchObject({
      code: "config_mismatch",
    });
  } finally {
    db.close();
  }
});
