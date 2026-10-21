import type { ModelName } from "@authtempo/core";
import { MYSQL_STRINGS } from "@authtempo/core/ddl";
import { afterAll, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase, type MysqlServer } from "./db.js";
import { rowOf } from "./rows.js";

// Decision 3 of plan 12g: the length bounds live in the MySQL column map
// only. D1 and Postgres store a longer value; MySQL answers invalid_argument.

const shared = new Map<MysqlServer, Promise<MysqlDatabase>>();
afterAll(async () => {
  for (const db of shared.values()) await (await db).close();
});
function databaseOf(server: MysqlServer): Promise<MysqlDatabase> {
  let db = shared.get(server);
  if (!db) {
    db = freshDatabase(server);
    shared.set(server, db);
  }
  return db;
}

let next = 0;

for (const server of MYSQL_SERVERS) {
  describe(`the MySQL length bounds on ${server.version}`, () => {
    for (const [key, row] of Object.entries(MYSQL_STRINGS)) {
      const [model, field] = key.split(".") as [ModelName, string];
      it(`stores ${key} at ${row.length} ${row.charset} characters and refuses one more`, async () => {
        const adapter = createMysqlAdapter((await databaseOf(server)).pool);
        // A one-byte character for an ascii column, a two-byte one for utf8mb4.
        const char = row.charset === "ascii" ? "a" : "é";
        next += 1;
        // A tail per test keeps each value new, so no unique key of an earlier test meets it.
        const tail = String(next).padStart(4, "0");
        const value = char.repeat(row.length - tail.length) + tail;
        const at = rowOf(model, { [field]: value } as never);
        await adapter.create(model, at);
        const id = (at as { id: string }).id;
        const back = await adapter.findOne(model, [{ field: "id", op: "eq", value: id } as never]);
        expect((back as Record<string, unknown> | null)?.[field]).toBe(value);
        const over = rowOf(model, { [field]: `${value}${char}` } as never);
        await expect(adapter.create(model, over)).rejects.toMatchObject({
          code: "invalid_argument",
          fields: [field],
        });
      });
    }
  });
}
