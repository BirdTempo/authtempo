import { env } from "cloudflare:test";
import { SCHEMA_VERSION, StorageError } from "@authtempo/core";
import { coreStatements, SQLITE, type SqlStatements, TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1AdapterOn, toStorageError } from "../src/index.js";
import { schemaVersionCheck } from "../src/schema-version.js";

type Counts = Record<keyof SqlStatements, number>;

function counting(): { statements: SqlStatements; counts: Counts } {
  const base = coreStatements(SQLITE);
  const counts = Object.fromEntries(Object.keys(base).map((k) => [k, 0])) as Counts;
  const statements = Object.fromEntries(
    Object.entries(base).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        counts[k as keyof SqlStatements]++;
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as SqlStatements;
  return { statements, counts };
}

const at = new Date("2026-10-10T00:00:00.000Z");
const user = (id: string, email: string) => ({
  id,
  email,
  emailVerified: false,
  name: null,
  image: null,
  createdAt: at,
  updatedAt: at,
});

describe("the D1 statements seam", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("routes every statement and every undo entry through the given statements", async () => {
    const { statements, counts } = counting();
    const db = createD1AdapterOn(env.DB, { statements, toStorageError, ready: async () => {} });
    await db.create("user", user("u1", "a@example.com"));
    await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u2", "b@example.com"));
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ada" });
        await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(counts).toMatchObject({
      insert: 2,
      select: 1,
      update: 1,
      undoSelect: 1,
      deleteReturning: 1,
      undoCreate: 1,
      restoreRow: 1,
      reinsertRow: 1,
    });
    expect(counts.decode).toBeGreaterThanOrEqual(1);
    const back = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
    expect(back?.name).toBeNull();
    expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u2" }])).toBeNull();
  });

  it("maps a unique violation through the given toStorageError", async () => {
    const seen: unknown[] = [];
    const db = createD1AdapterOn(env.DB, {
      statements: coreStatements(SQLITE),
      // A field list the package's own mapping never builds. An adapter that
      // ignores this option answers ["email"], so this test fails then.
      toStorageError: (model, err) => {
        seen.push(err);
        return new StorageError("unique_violation", model, ["marker"]);
      },
      ready: async () => {},
    });
    await db.create("user", user("u1", "a@example.com"));
    await expect(db.create("user", user("u2", "a@example.com"))).rejects.toMatchObject({
      code: "unique_violation",
      model: "user",
      fields: ["marker"],
    });
    expect(seen).toHaveLength(1);
  });

  it("maps a unique violation on update through the given toStorageError, outside and inside a transaction (plan 9 Task 3 M-1)", async () => {
    const seen: unknown[] = [];
    const db = createD1AdapterOn(env.DB, {
      statements: coreStatements(SQLITE),
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
  });

  it("runs ready before every method, and its throw stops the method before any statement (M-2)", async () => {
    // The real check on a database whose schema version is older than core's.
    await env.DB.prepare("UPDATE ta_meta SET value = '0' WHERE key = 'schema_version'").run();
    try {
      const { statements, counts } = counting();
      const db = createD1AdapterOn(env.DB, {
        statements,
        toStorageError,
        ready: schemaVersionCheck(env.DB),
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
          fields: ["0"],
        });
      }
      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    } finally {
      await env.DB.prepare("UPDATE ta_meta SET value = ? WHERE key = 'schema_version'")
        .bind(String(SCHEMA_VERSION))
        .run();
    }
  });

  it("runs ready again in a nested transaction, before its function (M-2)", async () => {
    let calls = 0;
    const db = createD1AdapterOn(env.DB, {
      statements: coreStatements(SQLITE),
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
  });

  it("reverses only a nested transaction's own writes when it throws and the outer one goes on (M-3, M-4)", async () => {
    const db = createD1AdapterOn(env.DB, {
      statements: coreStatements(SQLITE),
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
  });
});
