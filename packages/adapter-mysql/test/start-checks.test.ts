import { createServer } from "node:net";
import { StorageError } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase, poolOn } from "./db.js";
import { rowOf } from "./rows.js";

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** A port that no server listens on: the OS gives a free one, and the probe closes it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  await new Promise<void>((r) => server.close(() => r()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

const userCount = async (d: MysqlDatabase) =>
  (await d.q<{ n: number }[]>`SELECT COUNT(*) AS n FROM ta_user`)[0]?.n;

for (const server of MYSQL_SERVERS) {
  describe(`the start checks on MySQL ${server.version}`, () => {
    it("stops on a pool without FOUND_ROWS", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool2({ flags: ["-FOUND_ROWS"] }));
      const err = await adapter.create("user", rowOf("user")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({ code: "config_mismatch", fields: ["FOUND_ROWS"] });
      expect((err as Error).message).toBe(
        "config_mismatch on meta (FOUND_ROWS): the pool reports changed rows, not matched rows; keep the mysql2 flag FOUND_ROWS",
      );
      expect(await userCount(db)).toBe(0);
      // A failed check is not kept: the next call checks again and stops again.
      await expect(adapter.findOne("user", [])).rejects.toMatchObject({ code: "config_mismatch" });
    });

    it("stops on a session without strict mode", async () => {
      db = await freshDatabase(server);
      const adapter = createMysqlAdapter(db.pool2({ onConnect: "SET SESSION sql_mode = ''" }));
      const err = await adapter.findOne("user", []).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "config_mismatch", fields: ["sql_mode"] });
      expect((err as Error).message).toContain("STRICT_TRANS_TABLES");
    });

    it("stops on a table without the binary collation", async () => {
      db = await freshDatabase(server);
      // The operator's hand-run DDL. The same ALTER on ta_passkey fails with
      // 3886: its credential id key would pass 3072 bytes in utf8mb4.
      await db.pool.query(
        "ALTER TABLE ta_user CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
      );
      const err = await createMysqlAdapter(db.pool2())
        .findOne("user", [])
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "config_mismatch", fields: ["collation"] });
      expect((err as Error).message).toContain(
        "table ta_user has the collation utf8mb4_0900_ai_ci",
      );
    });

    it("reads no version on an empty database as schema_mismatch", async () => {
      db = await freshDatabase(server, { migrate: false });
      await expect(createMysqlAdapter(db.pool).findOne("user", [])).rejects.toMatchObject({
        code: "schema_mismatch",
      });
    });

    it("passes an outage through", async () => {
      const pool = poolOn(
        { ...server, url: `mysql://root:tempo@127.0.0.1:${await closedPort()}/` },
        "x",
      );
      try {
        const err = await createMysqlAdapter(pool)
          .findOne("user", [])
          .catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(StorageError);
        expect(err).toMatchObject({ code: "ECONNREFUSED" });
      } finally {
        await pool.end();
      }
    });
  });
}
