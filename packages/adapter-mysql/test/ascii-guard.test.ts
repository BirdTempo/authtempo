import type { StorageAdapter, Where } from "@authtempo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";
import { rowOf } from "./rows.js";

// The ascii columns on MySQL (src/ascii-guard.ts): a non-ASCII parameter is
// error 3988, and ascii_bin is PAD SPACE. The expected answers are the byte
// order of Postgres and D1. user.id is an ascii column of 64.

/** In byte order. "a b" holds an inner space, which an ascii column may hold. */
const IDS = ["a", "a b", "ab", "b", "~"];

for (const server of MYSQL_SERVERS) {
  describe(`the ascii guard on MySQL ${server.version}`, () => {
    let db: MysqlDatabase;
    let adapter: StorageAdapter;
    beforeAll(async () => {
      db = await freshDatabase(server);
      adapter = createMysqlAdapter(db.pool);
      for (const id of IDS) await adapter.create("user", rowOf("user", { id }));
    });
    afterAll(() => db.close());

    const ids = async (op: Where<"user">["op"], value: unknown) =>
      (
        await adapter.findMany("user", [{ field: "id", op, value }], {
          sort: { field: "id", dir: "asc" },
        })
      ).map((r) => r.id);

    it("refuses a write of a value that an ascii column cannot hold", async () => {
      for (const id of ["é", "x ", "x\u0001"])
        await expect(adapter.create("user", rowOf("user", { id }))).rejects.toMatchObject({
          code: "invalid_argument",
          fields: ["id"],
        });
      await expect(
        adapter.update("session", [{ field: "id", op: "eq", value: "none" }], {
          activeOrganizationId: "o ",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument", fields: ["activeOrganizationId"] });
    });

    it("matches nothing by eq with such a value", async () => {
      expect(await ids("eq", "é")).toEqual([]);
      // PAD SPACE alone would find "a".
      expect(await ids("eq", "a ")).toEqual([]);
      expect(await adapter.findOne("user", [{ field: "id", op: "eq", value: "a " }])).toBeNull();
      expect(
        await adapter.update("user", [{ field: "id", op: "eq", value: "a " }], { name: "x" }),
      ).toBe(0);
      expect(await adapter.delete("user", [{ field: "id", op: "eq", value: "é" }])).toBe(0);
    });

    it("matches by startsWith as Postgres does", async () => {
      expect(await ids("startsWith", "é")).toEqual([]);
      expect(await ids("startsWith", "a\u0001")).toEqual([]);
      // PAD SPACE alone would find "a" too.
      expect(await ids("startsWith", "a ")).toEqual(["a b"]);
    });

    it("drops such a value from in", async () => {
      expect(await ids("in", ["a", "é", "b "])).toEqual(["a"]);
      expect(await ids("in", ["é"])).toEqual([]);
    });

    it("turns ne with such a value into IS NOT NULL", async () => {
      expect(await ids("ne", "é")).toEqual(IDS);
      expect(await ids("ne", "a ")).toEqual(IDS);
    });

    it("keeps the byte order of Postgres for a range with such a value", async () => {
      // A character above U+007E sorts after each ASCII character.
      expect(await ids("lt", "aé")).toEqual(["a", "a b", "ab"]);
      expect(await ids("lte", "aé")).toEqual(["a", "a b", "ab"]);
      expect(await ids("gt", "aé")).toEqual(["b", "~"]);
      expect(await ids("gte", "aé")).toEqual(["b", "~"]);
      expect(await ids("gt", "~é")).toEqual([]);
      expect(await ids("lt", "~é")).toEqual(IDS);
      // A trailing space or a control character sorts before each character that the column holds.
      expect(await ids("lt", "a ")).toEqual(["a"]);
      expect(await ids("lte", "a ")).toEqual(["a"]);
      expect(await ids("gt", "a ")).toEqual(["a b", "ab", "b", "~"]);
      expect(await ids("gte", "a ")).toEqual(["a b", "ab", "b", "~"]);
      expect(await ids("lt", "a\u0001")).toEqual(["a"]);
      expect(await ids("gte", "a\u0001")).toEqual(["a b", "ab", "b", "~"]);
    });
  });
}
