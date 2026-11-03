// @ts-expect-error: bun:sqlite has its types in @types/bun, which this package does not take.
import { Database } from "bun:sqlite";
import { bunSqlite } from "@authtempo/adapter-sqlite/bun";
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

// The suite of mapping-bun.test.ts turns the keys on itself. This test opens
// the database as an app does, with no pragma, so only the storage turns
// them on (plan 12n).
describe("the foreign keys of the storage on bun:sqlite (plan 12n)", () => {
  it("turns the foreign keys on, so a user delete leaves no session row of that user", async () => {
    const db = new Database(":memory:");
    try {
      // bun:sqlite opens with the keys off. So the cascade below needs the storage's pragma.
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
      db.run(BETTER_AUTH_SQLITE);
      const compat = betterAuthSchemaStorage({ dialect: "sqlite", driver: bunSqlite(db) });
      await compat.migrate();
      const s = compat.storage;
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
      const sessionsOf = (userId: string) =>
        db.query(`SELECT count(*) AS n FROM "session" WHERE "userId" = ?`).get(userId);
      expect(await s.delete("user", [eq("id", "u1")])).toBe(1);
      expect([sessionsOf("u1"), sessionsOf("u2")]).toEqual([{ n: 0 }, { n: 2 }]);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });
});
