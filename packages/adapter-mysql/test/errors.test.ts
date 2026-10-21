import { afterEach, describe, expect, it } from "vitest";
import { createMysqlAdapter, toStorageError } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";
import { rowOf } from "./rows.js";

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** The error that the server answers to `sql`, through mysql2. */
async function driverError(d: MysqlDatabase, sql: string, params: unknown[]): Promise<unknown> {
  return d.pool.execute(sql, params as never[]).then(
    () => {
      throw new Error(`no error from ${sql}`);
    },
    (e: unknown) => e,
  );
}

for (const server of MYSQL_SERVERS) {
  describe(`toStorageError on MySQL ${server.version}`, () => {
    it("maps 1062 by the index name and copies no part of the message", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool);
      const email = "secret-address@example.com";
      await adapter.create("user", rowOf("user", { id: "u1", email }));
      const byEmail = await adapter
        .create("user", rowOf("user", { id: "u2", email }))
        .catch((e: unknown) => e);
      expect(byEmail).toMatchObject({ code: "unique_violation", fields: ["email"] });
      const byId = await adapter
        .create("user", rowOf("user", { id: "u1" }))
        .catch((e: unknown) => e);
      expect(byId).toMatchObject({ code: "unique_violation", fields: ["id"] });
      // The driver message names the value; the StorageError holds none of it.
      for (const e of [byEmail, byId]) {
        expect(JSON.stringify(e)).not.toContain("secret-address");
        expect((e as Error).message).not.toContain("secret-address");
        expect((e as Error).message).not.toContain("u1");
      }
      const twoFields = await adapter
        .create("identity", rowOf("identity", { provider: "github", subject: "42" }))
        .then(() =>
          adapter.create("identity", rowOf("identity", { provider: "github", subject: "42" })),
        )
        .catch((e: unknown) => e);
      expect(twoFields).toMatchObject({
        code: "unique_violation",
        fields: ["provider", "subject"],
      });
    });

    it("maps 1406, 1366, and 3988 to invalid_argument", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool);
      // 1406 through the adapter: an address of 255 characters in a column of 254.
      const long = await adapter
        .create("user", rowOf("user", { email: `${"a".repeat(243)}@example.com` }))
        .catch((e: unknown) => e);
      expect(long).toMatchObject({ code: "invalid_argument", fields: ["email"] });
      // The adapter sends no statement that answers 1366 or 3988: core checks
      // each type, and the ascii guard checks each ascii value. So the two
      // come from the server through a raw statement.
      await adapter.create("passkey", rowOf("passkey", { id: "k1" }));
      const e1366 = await driverError(db, "UPDATE ta_passkey SET counter = ? WHERE id = ?", [
        "many",
        "k1",
      ]);
      expect(e1366).toMatchObject({ errno: 1366 });
      expect(toStorageError("passkey", e1366)).toMatchObject({
        code: "invalid_argument",
        fields: ["counter"],
      });
      const e3988 = await driverError(db, "SELECT id FROM ta_user WHERE id = ?", ["é"]);
      expect(e3988).toMatchObject({ errno: 3988 });
      expect(toStorageError("user", e3988)).toMatchObject({ code: "invalid_argument", fields: [] });
      for (const e of [long, toStorageError("passkey", e1366)])
        expect((e as Error).message).not.toContain("many");
    });
  });
}
