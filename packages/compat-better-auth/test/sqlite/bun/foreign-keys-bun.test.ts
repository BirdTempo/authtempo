// @ts-expect-error: bun:sqlite has its types in @types/bun, which this package does not take.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSqlite } from "@authtempo/adapter-sqlite/bun";
import type { StorageAdapter } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../../fixtures.js";
import { at, eq } from "../../mapping-cases.js";

/** A session row of `userId`, as core writes one at a sign-in. */
const session = (id: string, userId: string) => ({
  id,
  userId,
  tokenHash: `h-${id}`,
  expiresAt: new Date(at.getTime() + 86_400_000),
  lastSeenAt: at,
  ip: null,
  userAgent: null,
  activeOrganizationId: null,
  freshAt: at,
  actorId: null,
  activeTeamId: null,
  createdAt: at,
  updatedAt: at,
});

/** The users u1 and u2, each with two sessions, through the storage port. */
async function twoUsers(s: StorageAdapter): Promise<void> {
  for (const id of ["u1", "u2"]) {
    await s.create("user", {
      id,
      email: `${id}@example.com`,
      emailVerified: false,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: at,
      updatedAt: at,
    });
    for (const n of [1, 2]) await s.create("session", session(`${id}-s${n}`, id));
  }
}

/** The session rows of u1 and of u2, read on the handle. */
const sessionsOf = (db: Database) =>
  ["u1", "u2"].map((u) =>
    db.query(`SELECT count(*) AS n FROM "session" WHERE "userId" = ?`).get(u),
  );

const keys = (db: Database) => db.query("PRAGMA foreign_keys").get();

// The suite of mapping-bun.test.ts turns the keys on itself. These tests open
// each database as an app does, with no pragma, so only the storage turns
// them on (plan 12n). bun:sqlite opens with the keys off, so each cascade
// below needs the storage's pragma.
describe("the foreign keys of the storage on bun:sqlite (plan 12n)", () => {
  it("turns the foreign keys on, so a user delete leaves no session row of that user", async () => {
    const db = new Database(":memory:");
    try {
      expect(keys(db)).toEqual({ foreign_keys: 0 });
      db.run(BETTER_AUTH_SQLITE);
      const compat = betterAuthSchemaStorage({ dialect: "sqlite", driver: bunSqlite(db) });
      await compat.migrate();
      // The migrations run with the keys on, as on D1 and the other drivers.
      expect(keys(db)).toEqual({ foreign_keys: 1 });
      await twoUsers(compat.storage);
      expect(await compat.storage.delete("user", [eq("id", "u1")])).toBe(1);
      expect(sessionsOf(db)).toEqual([{ n: 0 }, { n: 2 }]);
    } finally {
      db.close();
    }
  });

  it("turns the foreign keys on at the first call of a storage that runs no migration", async () => {
    // A deploy step migrates the file. Then the server opens a new connection
    // to it and runs no migration.
    const dir = mkdtempSync(join(tmpdir(), "authtempo-compat-bun-"));
    const file = join(dir, "db.sqlite");
    try {
      const deploy = new Database(file);
      deploy.run(BETTER_AUTH_SQLITE);
      await betterAuthSchemaStorage({ dialect: "sqlite", driver: bunSqlite(deploy) }).migrate();
      deploy.close();
      const db = new Database(file);
      try {
        expect(keys(db)).toEqual({ foreign_keys: 0 });
        const { storage } = betterAuthSchemaStorage({ dialect: "sqlite", driver: bunSqlite(db) });
        await twoUsers(storage);
        expect(await storage.delete("user", [eq("id", "u1")])).toBe(1);
        expect(sessionsOf(db)).toEqual([{ n: 0 }, { n: 2 }]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
