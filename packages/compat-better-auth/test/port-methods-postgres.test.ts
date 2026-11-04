import type { StorageAdapter } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { BETTER_AUTH_PG, CONSUMER_I_PG } from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";

// The two optional port methods of plan 12f (rulings 35 and 36) on the compat
// storage. Core's multi-row session deletes take `lockInOrder` first, so two
// flows that delete the same rows wait in one order and never deadlock. The
// compat storage passes both methods on from the Postgres adapter, with its
// own statements, so the lock read must run on Better Auth's tables.

const at = new Date("2026-10-10T00:00:00.000Z");
const later = new Date("2026-11-10T00:00:00.000Z");
const eq = <F extends string>(field: F, value: unknown) => ({ field, op: "eq" as const, value });

async function seed(db: StorageAdapter) {
  for (const id of ["u1", "u2"]) {
    await db.create("user", {
      id,
      email: `${id}@example.com`,
      emailVerified: true,
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
  }
  for (const [id, userId] of [
    ["s1", "u1"],
    ["s2", "u1"],
    ["s3", "u2"],
  ] as const) {
    await db.create("session", {
      id,
      userId,
      tokenHash: id.repeat(32),
      expiresAt: later,
      lastSeenAt: at,
      ip: null,
      userAgent: null,
      activeOrganizationId: null,
      activeTeamId: null,
      freshAt: at,
      actorId: null,
      proved: true,
      createdAt: at,
      updatedAt: at,
    });
  }
}

const NAMINGS = [
  { title: "camelCase", tables: BETTER_AUTH_PG, casing: "camel" as const },
  { title: "snake_case", tables: CONSUMER_I_PG, casing: "snake" as const },
];

describe.each(NAMINGS)(
  "the plan 12f port methods on the compat Postgres storage, $title",
  ({ tables, casing }) => {
    it("takes the row locks of the matched sessions with lockInOrder until the commit", async () => {
      const pg = await freshBetterAuthSchema(tables);
      try {
        const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, casing });
        await migrateWithoutLock(pg.sql, s.names);
        await seed(s.storage);
        const session = s.names.table("session");
        // NOWAIT on another connection: 55P03 while a lock is held, the row while it is not.
        const probe = (id: string) =>
          pg.sql.unsafe(`SELECT 1 FROM ${session} WHERE "id" = $1 FOR UPDATE NOWAIT`, [id]).then(
            () => "free",
            (e: { code?: string }) => (e.code === "55P03" ? "locked" : `error ${e.code}`),
          );
        expect(s.storage.lockInOrder).toBeTypeOf("function");
        const held = await s.storage.transaction(async (tx) => {
          await tx.lockInOrder?.("session", [eq("userId", "u1")]);
          return [await probe("s1"), await probe("s2"), await probe("s3")];
        });
        expect(held).toEqual(["locked", "locked", "free"]);
        expect([await probe("s1"), await probe("s2")]).toEqual(["free", "free"]);
      } finally {
        await pg.close();
      }
    });

    it("counts one statement per port call in statementsSent, the lock read too", async () => {
      const pg = await freshBetterAuthSchema(tables);
      try {
        const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, casing });
        await migrateWithoutLock(pg.sql, s.names);
        await seed(s.storage);
        const before = s.storage.statementsSent?.() ?? Number.NaN;
        await s.storage.transaction(async (tx) => {
          await tx.lockInOrder?.("session", [eq("userId", "u1")]);
          await tx.delete("session", [eq("userId", "u1")]);
        });
        await s.storage.findMany("session", []);
        expect((s.storage.statementsSent?.() ?? Number.NaN) - before).toBe(3);
      } finally {
        await pg.close();
      }
    });
  },
);
