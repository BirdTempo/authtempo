import { coreStatements, POSTGRES, type SqlStatements } from "@tempo-auth/core/sql";
import { describe, expect, it } from "vitest";
import { createPostgresAdapterOn, toStorageError } from "../src/index.js";
import { freshDatabase } from "./db.js";

describe("the Postgres statements seam", () => {
  it("routes every statement through the given statements", async () => {
    const pg = await freshDatabase();
    try {
      const base = coreStatements(POSTGRES);
      const seen: string[] = [];
      const statements: SqlStatements = {
        ...base,
        insert(m, d) {
          seen.push("insert");
          return base.insert(m, d);
        },
        select(m, w, o) {
          seen.push("select");
          return base.select(m, w, o);
        },
        update(m, w, d) {
          seen.push("update");
          return base.update(m, w, d);
        },
        delete(m, w) {
          seen.push("delete");
          return base.delete(m, w);
        },
        decode(m, r) {
          seen.push("decode");
          return base.decode(m, r);
        },
      };
      const db = createPostgresAdapterOn(pg.sql, {
        statements,
        toStorageError,
        ready: async () => {},
      });
      const at = new Date("2026-10-10T00:00:00.000Z");
      await db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: at,
          updatedAt: at,
        });
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ada" });
      });
      expect((await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]))?.name).toBe(
        "Ada",
      );
      await db.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(seen).toEqual(["insert", "update", "select", "decode", "delete"]);
    } finally {
      await pg.close();
    }
  });
});
