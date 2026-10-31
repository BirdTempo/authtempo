import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMysqlMigrations, createMysqlAdapter } from "@authtempo/adapter-mysql";
import { applyPostgresMigrations, createPostgresAdapter } from "@authtempo/adapter-postgres";
import { applySqliteMigrations, createSqliteAdapter } from "@authtempo/adapter-sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import type { Models, StorageAdapter } from "@authtempo/core";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, runBin, versionSlot } from "./support/bin.js";
import { freshMysqlDatabase, MYSQL_SERVERS } from "./support/mysql.js";
import { freshDatabase } from "./support/pg.js";

// `authtempo generate --format drizzle` (plan 12g Task 7). The adapter
// writes four rows. drizzle-orm 0.45.3 reads them through the printed file,
// and each value must equal the adapter's own read, with the same types.

/**
 * The printed files go into a temp folder outside the repo, so a stopped run
 * leaves nothing that git or lint reads. Vitest resolves their drizzle-orm
 * import from the package root.
 */
const OUT = mkdtempSync(join(tmpdir(), "authtempo-cli-generated-drizzle-"));
afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

beforeAll(() => {
  assertFreshBuild();
});

const at = (iso: string) => new Date(iso);

/** The four rows: dates with milliseconds, a boolean, JSON data, and a counter of 2^32 - 1. */
const USER: Models["user"] = {
  id: "user-drizzle-1",
  createdAt: at("2026-10-22T01:02:03.456Z"),
  updatedAt: at("2026-10-22T01:02:03.789Z"),
  email: "drizzle@example.com",
  emailVerified: true,
  name: "Drizzle Reader",
  image: null,
  bannedAt: null,
  banReason: null,
  banUntil: null,
  username: null,
  displayUsername: null,
  phone: null,
  isAnonymous: false,
};
const SESSION: Models["session"] = {
  id: "session-drizzle-1",
  createdAt: at("2026-10-22T01:02:04.001Z"),
  updatedAt: at("2026-10-22T01:02:04.002Z"),
  userId: USER.id,
  tokenHash: "a".repeat(64),
  expiresAt: at("2026-11-22T01:02:04.003Z"),
  lastSeenAt: at("2026-10-22T01:02:04.004Z"),
  ip: "192.0.2.1",
  userAgent: null,
  activeOrganizationId: null,
  freshAt: at("2026-10-22T01:02:04.005Z"),
  actorId: null,
  activeTeamId: null,
};
const VERIFICATION: Models["verification"] = {
  id: "verification-drizzle-1",
  createdAt: at("2026-10-22T01:02:05.001Z"),
  updatedAt: at("2026-10-22T01:02:05.002Z"),
  purpose: "email-otp",
  identifier: "drizzle@example.com",
  valueHash: "b".repeat(64),
  expiresAt: at("2026-10-22T01:12:05.003Z"),
  consumedAt: null,
  data: { attempts: 2, nested: { list: [1, "two", null] } },
  secretVersion: 1,
};
const PASSKEY: Models["passkey"] = {
  id: "passkey-drizzle-1",
  createdAt: at("2026-10-22T01:02:06.001Z"),
  updatedAt: at("2026-10-22T01:02:06.002Z"),
  userId: USER.id,
  credentialId: "Y3JlZGVudGlhbC1pZA",
  publicKey: "cHVibGljLWtleQ",
  counter: 4294967295,
  transports: "internal",
  deviceType: "multiDevice",
  backedUp: false,
  discoverable: null,
  prf: false,
  largeBlob: false,
  name: null,
};

async function writeRows(storage: StorageAdapter): Promise<void> {
  await storage.create("user", USER);
  await storage.create("session", SESSION);
  await storage.create("verification", VERIFICATION);
  await storage.create("passkey", PASSKEY);
}

/** The adapter's own read of the four rows. */
async function adapterRows(storage: StorageAdapter) {
  return {
    user: await storage.findOne("user", [{ field: "id", op: "eq", value: USER.id }]),
    session: await storage.findOne("session", [{ field: "id", op: "eq", value: SESSION.id }]),
    verification: await storage.findOne("verification", [
      { field: "id", op: "eq", value: VERIFICATION.id },
    ]),
    passkey: await storage.findOne("passkey", [{ field: "id", op: "eq", value: PASSKEY.id }]),
  };
}

/** The printed file of one dialect, written into the temp folder and imported. */
async function printedSchema(
  dialect: string,
): Promise<{ text: string; schema: Record<string, unknown> }> {
  const r = runBin(["generate", "--format", "drizzle", "--dialect", dialect]);
  expect(r.status, r.stderr).toBe(0);
  const folder = join(OUT, dialect);
  mkdirSync(folder);
  const file = join(folder, "schema.ts");
  writeFileSync(file, r.stdout);
  return { text: r.stdout, schema: (await import(file)) as Record<string, unknown> };
}

/** The types the adapter answers, so a read of the wrong type fails here as well as in toEqual. */
function expectTypes(rows: Awaited<ReturnType<typeof adapterRows>>): void {
  expect(rows.user?.createdAt).toBeInstanceOf(Date);
  expect(rows.user?.emailVerified).toBe(true);
  expect(rows.verification?.data).toEqual(VERIFICATION.data);
  expect(rows.passkey?.counter).toBe(4294967295);
  expect(rows.passkey?.backedUp).toBe(false);
}

type Reader = {
  select(): { from(t: never): { where(w: unknown): PromiseLike<unknown[]> | unknown[] } };
};

/** The four rows read through drizzle with the printed tables. */
async function drizzleRows(db: Reader, schema: Record<string, unknown>) {
  const one = async (table: string, id: string) => {
    const t = schema[table] as { id: never };
    const rows = await db
      .select()
      .from(t as never)
      .where(eq(t.id, id as never));
    expect(rows, table).toHaveLength(1);
    return rows[0];
  };
  return {
    user: await one("taUser", USER.id),
    session: await one("taSession", SESSION.id),
    verification: await one("taVerification", VERIFICATION.id),
    passkey: await one("taPasskey", PASSKEY.id),
  };
}

describe("authtempo generate --format drizzle (plan 12g Task 7)", () => {
  it("reads what the adapter wrote, with the same types: sqlite", async () => {
    const { text, schema } = await printedSchema("sqlite");
    const dir = mkdtempSync(join(tmpdir(), "authtempo-cli-drizzle-"));
    const file = join(dir, "app.db");
    const db = new DatabaseSync(file);
    const reader = new Database(file, { readonly: true });
    try {
      const driver = nodeSqlite(db);
      await applySqliteMigrations(driver);
      const storage = createSqliteAdapter(driver);
      await writeRows(storage);
      const mine = await adapterRows(storage);
      expectTypes(mine);
      const theirs = await drizzleRows(drizzleSqlite({ client: reader }) as never, schema);
      expectTypes(theirs as never);
      expect(theirs).toEqual(mine);
      // The snapshot comes last, so a wrong type fails the read compare first.
      await expect(versionSlot(text)).toMatchFileSnapshot(
        "__snapshots__/generate-drizzle-sqlite.ts.snap",
      );
    } finally {
      reader.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads what the adapter wrote, with the same types: postgres", async () => {
    const { text, schema } = await printedSchema("postgres");
    const db = await freshDatabase();
    try {
      await applyPostgresMigrations(db.sql);
      const storage = createPostgresAdapter(db.sql);
      await writeRows(storage);
      const mine = await adapterRows(storage);
      expectTypes(mine);
      const theirs = await drizzleRows(drizzlePostgres({ client: db.sql }) as never, schema);
      expectTypes(theirs as never);
      expect(theirs).toEqual(mine);
      // The snapshot comes last, so a wrong type fails the read compare first.
      await expect(versionSlot(text)).toMatchFileSnapshot(
        "__snapshots__/generate-drizzle-postgres.ts.snap",
      );
    } finally {
      await db.drop();
    }
  });

  it("reads what the adapter wrote, with the same types: mysql 8.4", async () => {
    const { text, schema } = await printedSchema("mysql");
    const db = await freshMysqlDatabase(MYSQL_SERVERS[0]);
    const pool = mysql.createPool({ uri: db.url, connectionLimit: 2, timezone: "Z" });
    try {
      await applyMysqlMigrations(pool);
      const storage = createMysqlAdapter(pool);
      await writeRows(storage);
      const mine = await adapterRows(storage);
      expectTypes(mine);
      const theirs = await drizzleRows(
        // The config form with mode fails the isConfig check of drizzle-orm
        // 0.45.3 (utils.js:144), so the read passes the pool by position.
        drizzleMysql(pool, { mode: "default" }) as never,
        schema,
      );
      expectTypes(theirs as never);
      expect(theirs).toEqual(mine);
      // The snapshot comes last, so a wrong type fails the read compare first.
      await expect(versionSlot(text)).toMatchFileSnapshot(
        "__snapshots__/generate-drizzle-mysql.ts.snap",
      );
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});
