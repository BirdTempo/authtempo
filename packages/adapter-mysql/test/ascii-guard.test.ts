import type { StorageAdapter } from "@authtempo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";
import { rowOf } from "./rows.js";

// The ascii columns on MySQL (src/ascii-guard.ts). A non-ASCII parameter is
// error 3988, and ascii_bin is PAD SPACE. The refusal of a write is MySQL
// only. The where answers are in core's conformance suite, so every store
// gives the same answer (ruling 9 of plan 12g). user.id is an ascii column.

for (const server of MYSQL_SERVERS) {
  describe(`the ascii guard on MySQL ${server.version}`, () => {
    let db: MysqlDatabase;
    let adapter: StorageAdapter;
    beforeAll(async () => {
      db = await freshDatabase(server);
      adapter = createMysqlAdapter(db.pool);
    });
    afterAll(() => db.close());

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
  });
}
