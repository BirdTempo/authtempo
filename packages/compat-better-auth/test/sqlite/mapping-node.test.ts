import { DatabaseSync } from "node:sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { eq } from "../mapping-cases.js";
import { sqliteCompatSuite } from "./suite.js";

await sqliteCompatSuite("node", () => {
  const db = new DatabaseSync(":memory:");
  return {
    driver: nodeSqlite(db),
    exec: async (text) => {
      db.exec(text);
    },
    close: () => db.close(),
  };
});

it("refuses a node:sqlite handle that reads integers as BigInt with config_mismatch", async () => {
  const db = new DatabaseSync(":memory:", { readBigInts: true });
  try {
    const s = betterAuthSchemaStorage({ dialect: "sqlite", driver: nodeSqlite(db) });
    await expect(s.storage.findOne("user", [eq("id", "x")])).rejects.toMatchObject({
      code: "config_mismatch",
    });
  } finally {
    db.close();
  }
});
