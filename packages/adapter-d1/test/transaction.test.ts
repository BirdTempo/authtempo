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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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

  it("undoes a createMany of 1000 rows with one delete (rulings 57 and 84 of plan 12d)", async () => {
    const db = createD1Adapter(env.DB);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `m-${String(i).padStart(4, "0")}`,
      groupId: "g1",
      scimUserId: `su-${i}`,
      createdAt: t0,
      updatedAt: t0,
    }));
    let write = 0;
    let afterWrite = 0;
    await expect(
      db.transaction(async (tx) => {
        const start = db.statementsSent?.() ?? 0;
        await tx.createMany("scimGroupMember", rows);
        afterWrite = db.statementsSent?.() ?? 0;
        write = afterWrite - start;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // One insert binds the 1000 rows as one JSON list, and one delete binds their ids.
    expect([write, (db.statementsSent?.() ?? 0) - afterWrite]).toEqual([1, 1]);
    expect(await db.findMany("scimGroupMember", [])).toEqual([]);
  });

  it("splits a createMany past 100 KB of statement into halves (ruling 84 of plan 12d)", async () => {
    const db = createD1Adapter(env.DB);
    // 1000 rows with a scimUserId of 256 characters: about 290 KB of JSON text.
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `m-${String(i).padStart(4, "0")}`,
      groupId: "g1",
      scimUserId: `su-${i}-`.padEnd(256, "x"),
      createdAt: t0,
      updatedAt: t0,
    }));
    await db.findOne("user", [{ field: "id", op: "eq", value: "none" }]);
    const start = db.statementsSent?.() ?? 0;
    await db.createMany("scimGroupMember", rows);
    // Halves of 500, then of 250 rows: four statements of about 72 KB each.
    expect((db.statementsSent?.() ?? 0) - start).toBe(4);
    expect(await db.findMany("scimGroupMember", [], { sort: { field: "id", dir: "asc" } })).toEqual(
      rows,
    );
  });

  it("joins the undo of createMany calls of one model, one after the other, into one delete per list (ruling 85 of plan 12d)", async () => {
    const db = createD1Adapter(env.DB);
    const rows = (g: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${g}-${String(i).padStart(4, "0")}`,
        groupId: g,
        scimUserId: `su-${i}`,
        createdAt: t0,
        updatedAt: t0,
      }));
    await db.create("scimGroup", {
      id: "keep",
      organizationId: "o1",
      displayName: "Keep",
      displayNameKey: "keep",
      externalId: null,
      teamId: null,
      version: 1,
      createdAt: t0,
      updatedAt: t0,
    });
    let afterWrite = 0;
    await expect(
      db.transaction(async (tx) => {
        // Four calls of 250 rows, as insertRows sends 1000 rows in four chunks.
        for (const g of ["a", "b", "c", "d"]) await tx.createMany("scimGroupMember", rows(g, 250));
        await tx.update("scimGroup", [{ field: "id", op: "eq", value: "keep" }], { version: 2 });
        await tx.createMany("scimGroupMember", rows("e", 3));
        afterWrite = db.statementsSent?.() ?? 0;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The undo: one delete of the last call, the restore of the group, one delete of the
    // four calls before it. It sent one delete per call before ruling 85: 6.
    expect((db.statementsSent?.() ?? 0) - afterWrite).toBe(3);
    expect(await db.findMany("scimGroupMember", [])).toEqual([]);
    expect(
      (await db.findOne("scimGroup", [{ field: "id", op: "eq", value: "keep" }]))?.version,
    ).toBe(1);
  });

  it("keeps the undo of an outer createMany out of the run of a nested transaction (ruling 85 of plan 12d)", async () => {
    const db = createD1Adapter(env.DB);
    const row = (id: string) => ({
      id,
      groupId: "g1",
      scimUserId: `su-${id}`,
      createdAt: t0,
      updatedAt: t0,
    });
    await db.transaction(async (tx) => {
      await tx.createMany("scimGroupMember", [row("outer-1"), row("outer-2")]);
      await expect(
        tx.transaction(async (inner) => {
          await inner.createMany("scimGroupMember", [row("inner-1"), row("inner-2")]);
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
      // After the nested call, a createMany of the outer level joins the outer run again.
      await tx.createMany("scimGroupMember", [row("outer-3"), row("outer-4")]);
    });
    const ids = (await db.findMany("scimGroupMember", [])).map((r) => r.id).sort();
    expect(ids).toEqual(["outer-1", "outer-2", "outer-3", "outer-4"]);
  });

  it("undoes an update and a delete of 1000 rows with one statement per list (ruling 84 of plan 12d)", async () => {
    const db = createD1Adapter(env.DB);
    const users = Array.from({ length: 1000 }, (_, i) => {
      const id = `u-${String(i).padStart(4, "0")}`;
      return {
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
        createdAt: t0,
        updatedAt: t0,
      };
    });
    await db.createMany("user", users);
    const all = () => db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
    const before = await all();
    const ids = users.map((u) => u.id);
    let afterWrite = 0;
    await expect(
      db.transaction(async (tx) => {
        await tx.update("user", [{ field: "id", op: "in", value: ids }], {
          name: "changed",
          updatedAt: new Date(t0.getTime() + 1000),
        });
        await tx.delete("user", [{ field: "id", op: "in", value: ids.slice(0, 500) }]);
        afterWrite = db.statementsSent?.() ?? 0;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The undo: one reinsert of the 500 deleted rows, one restore of the 1000 updated rows.
    // It sent one statement per row before ruling 84: 1500.
    expect((db.statementsSent?.() ?? 0) - afterWrite).toBe(2);
    expect(await all()).toEqual(before);
  });

  it("keeps a later write of another request in the undo of many rows (ruling 46 of plan 12k)", async () => {
    const db = createD1Adapter(env.DB);
    const users = Array.from({ length: 60 }, (_, i) => {
      const id = `u-${String(i).padStart(4, "0")}`;
      return {
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
        createdAt: t0,
        updatedAt: t0,
      };
    });
    await db.createMany("user", users);
    const ids = users.map((u) => u.id);
    await expect(
      db.transaction(async (tx) => {
        await tx.update("user", [{ field: "id", op: "in", value: ids }], { name: "changed" });
        // Another request writes the name of u-0001 and the address of u-0002 in the meantime.
        await env.DB.prepare("UPDATE ta_user SET name = 'other' WHERE id = 'u-0001'").run();
        await env.DB.prepare("UPDATE ta_user SET email_verified = 1 WHERE id = 'u-0002'").run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
    expect(after.map((u) => u.name)).toEqual(ids.map((id) => (id === "u-0001" ? "other" : null)));
    expect(after.filter((u) => u.emailVerified).map((u) => u.id)).toEqual(["u-0002"]);
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
          bannedAt: null,
          banReason: null,
          banUntil: null,
          username: null,
          displayUsername: null,
          phone: null,
          isAnonymous: false,
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
          bannedAt: null,
          banReason: null,
          banUntil: null,
          username: null,
          displayUsername: null,
          phone: null,
          isAnonymous: false,
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
            bannedAt: null,
            banReason: null,
            banUntil: null,
            username: null,
            displayUsername: null,
            phone: null,
            isAnonymous: false,
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
        bannedAt: null,
        banReason: null,
        banUntil: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: false,
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
            bannedAt: null,
            banReason: null,
            banUntil: null,
            username: null,
            displayUsername: null,
            phone: null,
            isAnonymous: false,
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
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
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
          bannedAt: null,
          banReason: null,
          banUntil: null,
          username: null,
          displayUsername: null,
          phone: null,
          isAnonymous: false,
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
          bannedAt: null,
          banReason: null,
          banUntil: null,
          username: null,
          displayUsername: null,
          phone: null,
          isAnonymous: false,
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
          bannedAt: null,
          banReason: null,
          banUntil: null,
          username: null,
          displayUsername: null,
          phone: null,
          isAnonymous: false,
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
