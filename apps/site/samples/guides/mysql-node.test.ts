import { randomBytes } from "node:crypto";
import { applyMysqlMigrations } from "@authtempo/adapter-mysql";
import { SCHEMA_VERSION } from "@authtempo/core";
import { createConnection, createPool, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { authOnMysql, remotePool } from "./mysql-node.ts";

// The MySQL 8.4 server of docker-compose.yml. The test fails, never skips,
// when the server does not answer: docker compose up -d mysql84.
const SERVER = process.env.AUTHTEMPO_MYSQL84_URL ?? "mysql://root:tempo@127.0.0.1:3384/";

/** A test database is site_<ms>_<hex>. A killed run leaves one, so a database older than this goes. */
const STALE_MS = 60 * 60 * 1000;

/** Makes a fresh database, drops the stale ones of killed runs, and answers its URL and its drop. */
async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  let admin: Awaited<ReturnType<typeof createConnection>>;
  try {
    admin = await createConnection({ uri: SERVER });
  } catch (e) {
    throw new Error(
      `the MySQL guide test needs MySQL 8.4 at ${new URL(SERVER).host}: ${(e as Error).message}. Run: docker compose up -d mysql84`,
    );
  }
  try {
    const [rows] = await admin.query<RowDataPacket[]>("SHOW DATABASES LIKE 'site\\_%'");
    for (const row of rows) {
      const name = String(Object.values(row)[0]);
      const made = Number(/^site_(\d+)_[0-9a-f]+$/.exec(name)?.[1] ?? Number.NaN);
      if (Date.now() - made > STALE_MS) await admin.query(`DROP DATABASE \`${name}\``);
    }
    const name = `site_${Date.now()}_${randomBytes(4).toString("hex")}`;
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    return {
      url: new URL(name, SERVER).href,
      drop: async () => {
        const c = await createConnection({ uri: SERVER });
        try {
          await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
        } finally {
          await c.end();
        }
      },
    };
  } finally {
    await admin.end();
  }
}

describe("authtempo on MySQL (the MySQL guide)", () => {
  it("migrates a fresh database, passes the checks at start, and signs a person in", async () => {
    const db = await freshDatabase();
    const pool = createPool({ uri: db.url });
    try {
      const h = harness();
      const auth = await authOnMysql(pool, h.mail, h.secret);
      const cookie = await signIn(auth, h, "ada@example.com");
      const session = await call(auth, "GET", "/auth/session", undefined, { cookie });
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
        "ada@example.com",
      );
      const [meta] = await pool.query<RowDataPacket[]>(
        "SELECT `value` FROM ta_meta WHERE `key` = 'schema_version'",
      );
      expect(meta.map((r) => r.value)).toEqual([String(SCHEMA_VERSION)]);
      // A second run of the migrations applies nothing.
      expect(await applyMysqlMigrations(pool)).toEqual([]);
    } finally {
      await pool.end();
      await db.drop();
    }
    // The baseline runs 30 steps, and the named lock of the
    // runner waits up to 60 s for another runner on the same server.
  }, 120_000);

  it("refuses the self-signed certificate of the test server with the remote pool", async () => {
    const pool = remotePool(SERVER);
    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(/certificate/);
    } finally {
      await pool.end();
    }
  });
});
