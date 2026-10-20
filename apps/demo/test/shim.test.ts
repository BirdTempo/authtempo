import { env, runInDurableObject } from "cloudflare:test";
import { toStorageError } from "@authtempo/adapter-d1";
import { coreStatements, SQLITE } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { sqliteD1 } from "../src/sqlite-d1.js";

const st = coreStatements(SQLITE);

/** A sandbox id as the Worker makes one: 16 random bytes in lower-case hex. */
function freshId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function user(id: string, email: string) {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    createdAt: at,
    updatedAt: at,
    email,
    emailVerified: false,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
  };
}

/** Runs `fn` inside a new sandbox, with the shim over its own store. */
async function inSandbox<R>(fn: (db: D1Database, sql: SqlStorage) => R | Promise<R>): Promise<R> {
  const stub = env.SANDBOX.get(env.SANDBOX.idFromName(freshId()));
  await stub.create();
  return runInDurableObject(stub, (_instance, state) =>
    fn(
      sqliteD1(state.storage.sql, (f) => state.storage.transactionSync(f)),
      state.storage.sql,
    ),
  );
}

describe("the D1 shim over ctx.storage.sql", () => {
  it("answers changes of an update as SQLite counts them", async () => {
    const counts = await inSandbox(async (db, sql) => {
      const ins = st.insert("user", user("u1", "a@example.com"));
      await db
        .prepare(ins.sql)
        .bind(...ins.params)
        .run();
      const res = await db
        .prepare("UPDATE ta_user SET email = ? WHERE id = ?")
        .bind("b@example.com", "u1")
        .run();
      // The same update on the cursor, for the breaks file: rowsWritten also counts index rows.
      const cursor = sql.exec("UPDATE ta_user SET email = ? WHERE id = ?", "c@example.com", "u1");
      cursor.toArray();
      return { changes: res.meta.changes, rowsWritten: cursor.rowsWritten };
    });
    console.log(`shim: changes=${counts.changes} rowsWritten=${counts.rowsWritten}`);
    expect(counts.changes).toBe(1);
  });

  it("answers 0 changes for a read after a write", async () => {
    const changes = await inSandbox(async (db) => {
      const ins = st.insert("user", user("u1", "a@example.com"));
      await db
        .prepare(ins.sql)
        .bind(...ins.params)
        .run();
      await db
        .prepare("UPDATE ta_user SET email = ? WHERE id = ?")
        .bind("b@example.com", "u1")
        .run();
      const read = await db.prepare("SELECT id FROM ta_user").run();
      return read.meta.changes;
    });
    expect(changes).toBe(0);
  });

  it("runs a batch as one unit", async () => {
    const left = await inSandbox(async (db) => {
      const a = st.insert("user", user("u1", "a@example.com"));
      const b = st.insert("user", user("u2", "a@example.com"));
      await expect(
        db.batch([db.prepare(a.sql).bind(...a.params), db.prepare(b.sql).bind(...b.params)]),
      ).rejects.toThrow(/UNIQUE constraint failed/);
      return db.prepare("SELECT id FROM ta_user WHERE id = ?").bind("u1").first();
    });
    expect(left).toBeNull();
  });

  it("passes a unique error through for toStorageError", async () => {
    const mapped = await inSandbox(async (db) => {
      const a = st.insert("user", user("u1", "a@example.com"));
      const b = st.insert("user", user("u2", "a@example.com"));
      await db
        .prepare(a.sql)
        .bind(...a.params)
        .run();
      try {
        await db
          .prepare(b.sql)
          .bind(...b.params)
          .run();
      } catch (e) {
        const err = toStorageError("user", e);
        return err ? { code: err.code, fields: [...err.fields] } : { message: String(e) };
      }
      return null;
    });
    expect(mapped).toEqual({ code: "unique_violation", fields: ["email"] });
  });

  it("answers first() of a column, and null for no row", async () => {
    const got = await inSandbox(async (db) => {
      const a = st.insert("user", user("u1", "a@example.com"));
      await db
        .prepare(a.sql)
        .bind(...a.params)
        .run();
      const q = "SELECT id, email FROM ta_user WHERE id = ?";
      return {
        column: await db.prepare(q).bind("u1").first<string>("email"),
        row: await db.prepare(q).bind("u1").first(),
        none: await db.prepare(q).bind("nobody").first(),
        noneColumn: await db.prepare(q).bind("nobody").first<string>("email"),
        // D1 throws this text for a column that is not in the row (workerd 1.20261006.1).
        missing: await db
          .prepare(q)
          .bind("u1")
          .first("name")
          .then(
            () => "no throw",
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          ),
      };
    });
    expect(got).toEqual({
      column: "a@example.com",
      row: { id: "u1", email: "a@example.com" },
      none: null,
      noneColumn: null,
      missing: "D1_COLUMN_NOTFOUND: Column not found (name)",
    });
  });
});
