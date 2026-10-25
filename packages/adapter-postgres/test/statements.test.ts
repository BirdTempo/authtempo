import { StorageError } from "@authtempo/core";
import { coreStatements, POSTGRES, type SqlStatements } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createPostgresAdapterOn, toStorageError } from "../src/index.js";
import { schemaVersionCheck } from "../src/schema-version.js";
import { freshDatabase, freshSchema } from "./db.js";

describe("the Postgres statements seam", () => {
  it("routes every statement through the given statements", async () => {
    const pg = await freshDatabase();
    try {
      const base = coreStatements(POSTGRES);
      const seen: string[] = [];
      const statements: SqlStatements = {
        ...base,
        insert(m, d) {
          seen.push("insert");
          return base.insert(m, d);
        },
        select(m, w, o) {
          seen.push("select");
          return base.select(m, w, o);
        },
        update(m, w, d) {
          seen.push("update");
          return base.update(m, w, d);
        },
        delete(m, w) {
          seen.push("delete");
          return base.delete(m, w);
        },
        decode(m, r) {
          seen.push("decode");
          return base.decode(m, r);
        },
      };
      const db = createPostgresAdapterOn(pg.sql, {
        statements,
        toStorageError,
        ready: async () => {},
      });
      const at = new Date("2026-10-10T00:00:00.000Z");
      await db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
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
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ada" });
      });
      expect((await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]))?.name).toBe(
        "Ada",
      );
      await db.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(seen).toEqual(["insert", "update", "select", "decode", "delete"]);
    } finally {
      await pg.close();
    }
  });

  const at = new Date("2026-10-10T00:00:00.000Z");
  const user = (id: string, email: string) => ({
    id,
    email,
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

  it("maps a unique violation on update through the given toStorageError, outside and inside a transaction (plan 9 Task 3 M-1)", async () => {
    const pg = await freshDatabase();
    try {
      const seen: unknown[] = [];
      const db = createPostgresAdapterOn(pg.sql, {
        statements: coreStatements(POSTGRES),
        toStorageError: (model, err) => {
          seen.push(err);
          return new StorageError("unique_violation", model, ["marker"]);
        },
        ready: async () => {},
      });
      await db.create("user", user("u1", "a@example.com"));
      await db.create("user", user("u2", "b@example.com"));
      const clash = (tx: typeof db) =>
        tx.update("user", [{ field: "id", op: "eq", value: "u2" }], { email: "a@example.com" });
      const mapped = { code: "unique_violation", model: "user", fields: ["marker"] };
      await expect(clash(db)).rejects.toMatchObject(mapped);
      await expect(db.transaction(clash)).rejects.toMatchObject(mapped);
      expect(seen).toHaveLength(2);
    } finally {
      await pg.close();
    }
  });

  it("runs ready before every method, and its throw stops the method before any statement (M-2)", async () => {
    // The real check on a schema with no migration: ta_meta does not exist.
    const pg = await freshSchema();
    try {
      const base = coreStatements(POSTGRES);
      let built = 0;
      const statements = Object.fromEntries(
        Object.entries(base).map(([k, fn]) => [
          k,
          (...args: unknown[]) => {
            built++;
            return (fn as (...a: unknown[]) => unknown)(...args);
          },
        ]),
      ) as unknown as SqlStatements;
      const db = createPostgresAdapterOn(pg.a, {
        statements,
        toStorageError,
        ready: schemaVersionCheck(pg.a),
      });
      for (const call of [
        () => db.create("user", user("u1", "a@example.com")),
        () => db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]),
        () => db.findMany("user", []),
        () => db.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "x" }),
        () => db.delete("user", [{ field: "id", op: "eq", value: "u1" }]),
        () => db.transaction(async () => 1),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: "schema_mismatch",
          model: "meta",
          fields: ["none"],
        });
      }
      expect(built).toBe(0);
    } finally {
      await pg.close();
    }
  });

  it("runs ready again in a nested transaction, before its function (M-2)", async () => {
    const pg = await freshDatabase();
    try {
      let calls = 0;
      const db = createPostgresAdapterOn(pg.sql, {
        statements: coreStatements(POSTGRES),
        toStorageError,
        // The outer transaction's check passes; the nested one's throws.
        ready: async () => {
          calls++;
          if (calls > 1) throw new StorageError("schema_mismatch", "meta", ["0"]);
        },
      });
      let ran = false;
      await expect(
        db.transaction((tx) =>
          tx.transaction(async () => {
            ran = true;
          }),
        ),
      ).rejects.toMatchObject({ code: "schema_mismatch", model: "meta", fields: ["0"] });
      expect(calls).toBe(2);
      expect(ran).toBe(false);
    } finally {
      await pg.close();
    }
  });

  it("rolls a nested transaction back to its savepoint and keeps the outer writes (M-3, M-4)", async () => {
    const pg = await freshDatabase();
    try {
      const db = createPostgresAdapterOn(pg.sql, {
        statements: coreStatements(POSTGRES),
        toStorageError,
        ready: async () => {},
      });
      await db.transaction(async (tx) => {
        await tx.create("user", user("u1", "a@example.com"));
        await expect(
          tx.transaction(async (inner) => {
            await inner.create("user", user("u2", "b@example.com"));
            throw new Error("inner");
          }),
        ).rejects.toThrow("inner");
        await tx.create("user", user("u3", "c@example.com"));
      });
      const ids = (await db.findMany("user", [], { sort: { field: "id", dir: "asc" } })).map(
        (u) => u.id,
      );
      expect(ids).toEqual(["u1", "u3"]);
    } finally {
      await pg.close();
    }
  });
});
