import { DatabaseSync } from "node:sqlite";
import { createAuth, SCHEMA_VERSION, type StorageAdapter } from "@authtempo/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { betterSqlite3 } from "../src/better-sqlite3.js";
import { applySqliteMigrations, createSqliteAdapter, SQLITE_MIGRATIONS } from "../src/index.js";
import { runSqliteMigrations } from "../src/migrations.js";
import { nodeSqlite } from "../src/node.js";
import { DRIVER_KINDS, openDriver } from "./support/drivers.js";

// The readiness route of plan 12h on SQLite (ruling 26 of the 12g lane). The
// route calls the adapter's ping, so it answers ready on a migrated database
// and not_ready schema on a database before the last migration. The ping
// runs the integer check first (ruling 27), so a handle that every call
// refuses answers not_ready storage.

const BASE = "https://api.example.com";

/** The migrations before the one of SCHEMA_VERSION: an app has them before it runs the new file. */
function beforeLast() {
  const cut = SQLITE_MIGRATIONS.findIndex((m) =>
    m.name.startsWith(`${String(SCHEMA_VERSION).padStart(4, "0")}_`),
  );
  if (cut < 1) throw new Error(`no migration file of version ${SCHEMA_VERSION}`);
  return SQLITE_MIGRATIONS.slice(0, cut);
}

/** The answer of GET /auth/ready on `storage`. */
async function readyOn(storage: StorageAdapter) {
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    mail: { send: async () => {} },
    observe: { sink: { write: () => {} }, readiness: true },
  });
  const res = await auth.handle(new Request(`${BASE}/auth/ready`));
  return { status: res.status, body: await res.json() };
}

async function ready(kind: (typeof DRIVER_KINDS)[number], migrate: "all" | "before-last") {
  const d = openDriver(kind);
  try {
    if (migrate === "all") await applySqliteMigrations(d.driver);
    else await runSqliteMigrations(d.driver, beforeLast());
    return await readyOn(createSqliteAdapter(d.driver));
  } finally {
    d.close();
  }
}

describe("GET /ready on SQLite (plan 12h Task 8, ruling 26 of the 12g lane)", () => {
  it.each(DRIVER_KINDS)("answers ready on a migrated database: %s", async (kind) => {
    expect(await ready(kind, "all")).toEqual({ status: 200, body: { status: "ready" } });
  });

  it.each(DRIVER_KINDS)("answers not_ready schema before the last migration: %s", async (kind) => {
    expect(await ready(kind, "before-last")).toEqual({
      status: 503,
      body: { error: "not_ready", reason: "schema" },
    });
  });

  it("answers not_ready storage on a migrated node:sqlite handle that reads BigInt", async () => {
    const db = new DatabaseSync(":memory:", { readBigInts: true });
    try {
      // The runner reads no integer, so the migrations apply on this handle.
      const driver = nodeSqlite(db);
      await applySqliteMigrations(driver);
      expect(await readyOn(createSqliteAdapter(driver))).toEqual({
        status: 503,
        body: { error: "not_ready", reason: "storage" },
      });
    } finally {
      db.close();
    }
  });

  it("keeps no failed integer check: the next ping checks again", async () => {
    const db = new Database(":memory:");
    try {
      const driver = betterSqlite3(db);
      await applySqliteMigrations(driver);
      const storage = createSqliteAdapter(driver);
      db.defaultSafeIntegers(true);
      await expect(storage.ping?.()).rejects.toMatchObject({ code: "config_mismatch" });
      db.defaultSafeIntegers(false);
      await expect(storage.ping?.()).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });
});
