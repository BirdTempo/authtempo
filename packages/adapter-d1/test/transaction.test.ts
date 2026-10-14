import { env } from "cloudflare:test";
import { StorageError } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("d1 undo log", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("restores a row that was updated and then deleted in the same failing transaction", async () => {
    const db = createD1Adapter(env.DB);
    await db.create("user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: false,
      name: "Ada",
      image: null,
      createdAt: t0,
      updatedAt: t0,
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Changed" });
        await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
    expect(row).toMatchObject({ id: "u1", name: "Ada", email: "a@example.com" });
  });

  it("removes a row created and then updated in a failing transaction", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "x" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findMany("user", [])).toEqual([]);
  });

  it("a nested transaction shares the undo log and the outer throw reverses both", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        await tx.transaction(async (inner) => {
          await inner.create("user", {
            id: "u2",
            email: "b@example.com",
            emailVerified: false,
            name: null,
            image: null,
            createdAt: t0,
            updatedAt: t0,
          });
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findMany("user", [])).toEqual([]);
  });

  it("keeps the inner writes out when an inner throw is caught and the outer commits", async () => {
    const db = createD1Adapter(env.DB);
    await db.transaction(async (tx) => {
      await tx.create("user", {
        id: "u1",
        email: "a@example.com",
        emailVerified: false,
        name: null,
        image: null,
        createdAt: t0,
        updatedAt: t0,
      });
      await tx
        .transaction(async (inner) => {
          await inner.create("user", {
            id: "u2",
            email: "b@example.com",
            emailVerified: false,
            name: null,
            image: null,
            createdAt: t0,
            updatedAt: t0,
          });
          throw new Error("inner");
        })
        .catch(() => {});
    });
    const rows = await db.findMany("user", []);
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });

  it("runs every undo entry and throws rollback_failed with the original in cause when one fails", async () => {
    const db = createD1Adapter(env.DB);
    await db.create("user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: t0,
      updatedAt: t0,
    });
    const original = new Error("boom");
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.create("user", {
          id: "u3",
          email: "c@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
        // Another request takes the email that the re-insert of u1 needs.
        await db.create("user", {
          id: "u2",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        throw original;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect(caught).toMatchObject({ code: "rollback_failed", fields: ["user:delete"] });
    const cause = (caught as Error).cause as { original: unknown; failures: unknown[] };
    expect(cause.original).toBe(original);
    expect(original.cause).toBeUndefined();
    expect(cause.failures).toHaveLength(1);
    const ids = (await db.findMany("user", [])).map((r) => r.id);
    expect(ids).toEqual(["u2"]);
  });

  it("rethrows the original error unchanged when every undo entry succeeds", async () => {
    const db = createD1Adapter(env.DB);
    const original = new Error("boom");
    const caught = await db
      .transaction(async (tx) => {
        await tx.create("user", {
          id: "u1",
          email: "a@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        });
        throw original;
      })
      .catch((e: unknown) => e);
    expect(caught).toBe(original);
    expect(original.cause).toBeUndefined();
    expect(await db.findMany("user", [])).toEqual([]);
  });

  it("does not un-consume a token that another request consumed between the read and the write", async () => {
    const real = createD1Adapter(env.DB);
    const t1 = new Date("2026-01-02T00:00:00.000Z");
    await real.create("verification", {
      id: "v1",
      purpose: "magic-link",
      identifier: "a@example.com",
      valueHash: "h1",
      expiresAt: t1,
      consumedAt: null,
      data: null,
      createdAt: t0,
      updatedAt: t0,
      secretVersion: 1,
    });
    // The wrapper lets another request consume the row right after this
    // request's first read of the verification table (or before its batch).
    let fired = false;
    const fire = async () => {
      if (fired) return;
      fired = true;
      await real.update("verification", [{ field: "id", op: "eq", value: "v1" }], {
        consumedAt: t1,
      });
    };
    const wrapStatement = (sql: string, params: unknown[]): D1PreparedStatement =>
      ({
        sql,
        params,
        bind: (...p: unknown[]) => wrapStatement(sql, p),
        all: async () => {
          const r = await env.DB.prepare(sql)
            .bind(...params)
            .all();
          if (/^SELECT .*ta_verification/.test(sql)) await fire();
          return r;
        },
        first: async (col: string) =>
          env.DB.prepare(sql)
            .bind(...params)
            .first(col),
        run: async () =>
          env.DB.prepare(sql)
            .bind(...params)
            .run(),
      }) as unknown as D1PreparedStatement;
    const wrapped = {
      prepare: (sql: string) => wrapStatement(sql, []),
      batch: async (stmts: { sql: string; params: unknown[] }[]) => {
        await fire();
        return env.DB.batch(stmts.map((x) => env.DB.prepare(x.sql).bind(...x.params)));
      },
    } as unknown as D1Database;
    const db = createD1Adapter(wrapped);
    await expect(
      db.transaction(async (tx) => {
        const n = await tx.update(
          "verification",
          [
            { field: "id", op: "eq", value: "v1" },
            { field: "consumedAt", op: "eq", value: null },
          ],
          { consumedAt: t0 },
        );
        if (n === 0) throw new Error("already consumed");
      }),
    ).rejects.toThrow("already consumed");
    const row = await real.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
    expect(row?.consumedAt).toEqual(t1);
  });
});
