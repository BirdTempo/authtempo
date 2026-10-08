import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityRow, PasskeyRow, UserRow, VerificationRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "./port.js";

export interface ConformanceTarget {
  adapter: StorageAdapter;
  close(): Promise<void>;
}

function user(id: string, email: string, at: Date): UserRow {
  return { id, email, emailVerified: false, name: null, image: null, createdAt: at, updatedAt: at };
}

function verification(id: string, at: Date, consumedAt: Date | null): VerificationRow {
  return {
    id,
    purpose: "magic-link",
    identifier: "a@example.com",
    valueHash: `hash-${id}`,
    expiresAt: new Date(at.getTime() + 60_000),
    consumedAt,
    data: { next: "/home", n: 1 },
    createdAt: at,
    updatedAt: at,
  };
}

function identity(id: string, provider: string, subject: string, at: Date): IdentityRow {
  return { id, userId: "u1", provider, subject, linkedAt: at, createdAt: at, updatedAt: at };
}

function passkey(id: string, counter: number, at: Date): PasskeyRow {
  return {
    id,
    userId: "u1",
    credentialId: `cred-${id}`,
    publicKey: "pk",
    counter,
    transports: null,
    deviceType: "singleDevice",
    backedUp: false,
    name: null,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * The contract every adapter must pass. Call it from the adapter's own test
 * file with a factory that opens a fresh, empty database.
 */
export function runAdapterConformance(
  name: string,
  factory: () => Promise<ConformanceTarget>,
): void {
  describe(`storage conformance: ${name}`, () => {
    let target: ConformanceTarget;
    let db: StorageAdapter;
    const t0 = new Date("2026-01-01T00:00:00.000Z");

    beforeEach(async () => {
      target = await factory();
      db = target.adapter;
    });
    afterEach(async () => {
      await target.close();
    });

    it("creates and finds one by eq", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      const found = await db.findOne("user", [
        { field: "email", op: "eq", value: "a@example.com" },
      ]);
      expect(found?.id).toBe("u1");
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.createdAt.getTime()).toBe(t0.getTime());
    });

    it("returns null when nothing matches", async () => {
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "nope" }])).toBeNull();
    });

    it("round-trips null, boolean, integer, and json fields", async () => {
      await db.create("verification", verification("v1", t0, null));
      const row = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
      expect(row?.consumedAt).toBeNull();
      expect(row?.data).toEqual({ next: "/home", n: 1 });
      await db.create("user", { ...user("u1", "a@example.com", t0), emailVerified: true });
      const u = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(u?.emailVerified).toBe(true);
    });

    it("findMany supports in, gt, sort, and limit", async () => {
      for (let i = 1; i <= 5; i++) {
        await db.create(
          "user",
          user(`u${i}`, `${i}@example.com`, new Date(t0.getTime() + i * 1000)),
        );
      }
      const some = await db.findMany("user", [
        { field: "id", op: "in", value: ["u1", "u3", "u9"] },
      ]);
      expect(some.map((r) => r.id).sort()).toEqual(["u1", "u3"]);
      const later = await db.findMany(
        "user",
        [{ field: "createdAt", op: "gt", value: new Date(t0.getTime() + 2000) }],
        { sort: { field: "createdAt", dir: "desc" }, limit: 2 },
      );
      expect(later.map((r) => r.id)).toEqual(["u5", "u4"]);
    });

    it("matches eq null and ne null", async () => {
      await db.create("verification", verification("v1", t0, null));
      await db.create("verification", verification("v2", t0, t0));
      const open = await db.findMany("verification", [
        { field: "consumedAt", op: "eq", value: null },
      ]);
      expect(open.map((r) => r.id)).toEqual(["v1"]);
      const spent = await db.findMany("verification", [
        { field: "consumedAt", op: "ne", value: null },
      ]);
      expect(spent.map((r) => r.id)).toEqual(["v2"]);
    });

    it("update returns the count and a conditional update returns 0 when nothing matches", async () => {
      await db.create("verification", verification("v1", t0, null));
      const first = await db.update(
        "verification",
        [
          { field: "valueHash", op: "eq", value: "hash-v1" },
          { field: "consumedAt", op: "eq", value: null },
        ],
        { consumedAt: t0 },
      );
      expect(first).toBe(1);
      const second = await db.update(
        "verification",
        [
          { field: "valueHash", op: "eq", value: "hash-v1" },
          { field: "consumedAt", op: "eq", value: null },
        ],
        { consumedAt: t0 },
      );
      expect(second).toBe(0);
    });

    it("delete returns the count", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await db.create("user", user("u2", "b@example.com", t0));
      expect(await db.delete("user", [{ field: "id", op: "in", value: ["u1", "u2"] }])).toBe(2);
      expect(await db.delete("user", [{ field: "id", op: "eq", value: "u1" }])).toBe(0);
    });

    it("rejects a unique violation with StorageError", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(db.create("user", user("u2", "a@example.com", t0))).rejects.toMatchObject({
        name: "StorageError",
        code: "unique_violation",
        model: "user",
      });
      await expect(db.create("user", user("u2", "a@example.com", t0))).rejects.toBeInstanceOf(
        StorageError,
      );
    });

    it("rolls back a transaction when the function throws", async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.create("user", user("u1", "a@example.com", t0));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }])).toBeNull();
    });

    it("commits a transaction and returns its value", async () => {
      const value = await db.transaction(async (tx) => {
        await tx.create("user", user("u1", "a@example.com", t0));
        return 42;
      });
      expect(value).toBe(42);
      expect((await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]))?.id).toBe("u1");
    });

    it("keeps a write made outside a failing transaction", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let started!: () => void;
      const inside = new Promise<void>((r) => {
        started = r;
      });
      const failing = db.transaction(async (tx) => {
        await tx.create("user", user("u1", "a@example.com", t0));
        started();
        await gate;
        throw new Error("boom");
      });
      await inside;
      await db.create("user", user("u2", "b@example.com", t0));
      release();
      await expect(failing).rejects.toThrow("boom");
      const rows = await db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
      expect(rows.map((r) => r.id)).toEqual(["u2"]);
    });

    it("leaves one row when two transactions read then create the same email", async () => {
      const findOrCreate = (id: string) =>
        db.transaction(async (tx) => {
          const found = await tx.findOne("user", [
            { field: "email", op: "eq", value: "a@example.com" },
          ]);
          return found ?? (await tx.create("user", user(id, "a@example.com", t0)));
        });
      const results = await Promise.allSettled([findOrCreate("u1"), findOrCreate("u2")]);
      const rejected = results.filter((r) => r.status === "rejected");
      // A SQL adapter may reject the loser with unique_violation. It must never lose the winner.
      expect(rejected.length).toBeLessThanOrEqual(1);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: "unique_violation" });
      const rows = await db.findMany("user", []);
      expect(rows).toHaveLength(1);
      for (const r of results) {
        if (r.status === "fulfilled") expect(r.value.id).toBe(rows[0]?.id);
      }
    });

    it("shows a transaction its own writes", async () => {
      const seen = await db.transaction(async (tx) => {
        await tx.create("user", user("u1", "a@example.com", t0));
        await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ada" });
        return tx.findOne("user", [{ field: "email", op: "eq", value: "a@example.com" }]);
      });
      expect(seen?.name).toBe("Ada");
    });

    it("an empty in list matches nothing on every method", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      const none = [{ field: "id" as const, op: "in" as const, value: [] }];
      expect(await db.findMany("user", none)).toEqual([]);
      expect(await db.findOne("user", none)).toBeNull();
      expect(await db.update("user", none, { name: "x" })).toBe(0);
      expect(await db.delete("user", none)).toBe(0);
      const row = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(row?.name).toBeNull();
    });

    it("update and delete with an empty where throw invalid_argument and change nothing", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(db.update("user", [], { name: "x" })).rejects.toMatchObject({
        name: "StorageError",
        code: "invalid_argument",
      });
      await expect(db.delete("user", [])).rejects.toMatchObject({
        name: "StorageError",
        code: "invalid_argument",
      });
      const rows = await db.findMany("user", []);
      expect(rows.map((r) => [r.id, r.name])).toEqual([["u1", null]]);
    });

    it("limit 0 returns nothing, and a limit that is not a non-negative integer throws", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      expect(await db.findMany("user", [], { limit: 0 })).toEqual([]);
      for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(db.findMany("user", [], { limit })).rejects.toMatchObject({
          name: "StorageError",
          code: "invalid_argument",
        });
      }
    });

    it("rejects an unknown field", async () => {
      await expect(
        db.findOne("user", [{ field: "nope" as "id", op: "eq", value: 1 }]),
      ).rejects.toMatchObject({ code: "unknown_field" });
    });

    it("create rejects an existing id and keeps the first row", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(db.create("user", user("u1", "b@example.com", t0))).rejects.toMatchObject({
        code: "unique_violation",
        model: "user",
        fields: ["id"],
      });
      const row = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(row?.email).toBe("a@example.com");
    });

    it("rejects an unknown model on every method", async () => {
      for (const bad of ["nope", "toString"] as unknown as "user"[]) {
        const w = [{ field: "id" as const, op: "eq" as const, value: "x" }];
        const calls = [
          db.create(bad, user("u1", "a@example.com", t0)),
          db.findOne(bad, w),
          db.findMany(bad, w),
          db.update(bad, w, { name: "x" }),
          db.delete(bad, w),
        ];
        for (const call of calls) {
          await expect(call).rejects.toMatchObject({ name: "StorageError", code: "unknown_model" });
        }
      }
    });

    it("update is all or nothing when a new row breaks a unique key", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await db.create("user", user("u2", "b@example.com", t0));
      await expect(
        db.update("user", [{ field: "id", op: "in", value: ["u1", "u2"] }], {
          email: "same@example.com",
        }),
      ).rejects.toMatchObject({ code: "unique_violation", fields: ["email"] });
      const rows = await db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
      expect(rows.map((r) => r.email)).toEqual(["a@example.com", "b@example.com"]);
    });

    it("update rejects a unique violation against another row", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await db.create("user", user("u2", "b@example.com", t0));
      await expect(
        db.update("user", [{ field: "id", op: "eq", value: "u2" }], { email: "a@example.com" }),
      ).rejects.toMatchObject({ code: "unique_violation" });
      const u2 = await db.findOne("user", [{ field: "id", op: "eq", value: "u2" }]);
      expect(u2?.email).toBe("b@example.com");
    });

    it("update rejects an id in data", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(
        db.update("user", [{ field: "id", op: "eq", value: "u1" }], { id: "u9" } as never),
      ).rejects.toMatchObject({ code: "unknown_field", fields: ["id"] });
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }])).not.toBeNull();
    });

    it("null rules: ne x skips null rows, in skips null rows, eq and ne null are IS NULL", async () => {
      await db.create("user", { ...user("u1", "1@example.com", t0), name: null });
      await db.create("user", { ...user("u2", "2@example.com", t0), name: "x" });
      await db.create("user", { ...user("u3", "3@example.com", t0), name: "y" });
      const ids = async (op: "eq" | "ne" | "in", value: unknown) =>
        (
          await db.findMany("user", [{ field: "name", op, value }], {
            sort: { field: "id", dir: "asc" },
          })
        ).map((r) => r.id);
      expect(await ids("eq", null)).toEqual(["u1"]);
      expect(await ids("ne", null)).toEqual(["u2", "u3"]);
      expect(await ids("ne", "x")).toEqual(["u3"]);
      expect(await ids("in", ["x", null])).toEqual(["u2"]);
      expect(await ids("in", [null])).toEqual([]);
    });

    it("null rules: lt, lte, gt, gte are false against a null field", async () => {
      await db.create("verification", verification("v1", t0, null));
      await db.create("verification", verification("v2", t0, t0));
      const ids = async (op: "lt" | "lte" | "gt" | "gte", value: unknown) =>
        (await db.findMany("verification", [{ field: "consumedAt", op, value }])).map((r) => r.id);
      const later = new Date(t0.getTime() + 1000);
      const earlier = new Date(t0.getTime() - 1000);
      expect(await ids("lt", later)).toEqual(["v2"]);
      expect(await ids("lte", t0)).toEqual(["v2"]);
      expect(await ids("gt", earlier)).toEqual(["v2"]);
      expect(await ids("gte", t0)).toEqual(["v2"]);
      expect(await ids("gt", null)).toEqual([]);
    });

    it("findMany supports lt, lte, and gte at the boundary", async () => {
      for (let i = 1; i <= 3; i++) {
        await db.create(
          "user",
          user(`u${i}`, `${i}@example.com`, new Date(t0.getTime() + i * 1000)),
        );
      }
      const mid = new Date(t0.getTime() + 2000);
      const ids = async (op: "lt" | "lte" | "gte") =>
        (
          await db.findMany("user", [{ field: "createdAt", op, value: mid }], {
            sort: { field: "createdAt", dir: "asc" },
          })
        ).map((r) => r.id);
      expect(await ids("lt")).toEqual(["u1"]);
      expect(await ids("lte")).toEqual(["u1", "u2"]);
      expect(await ids("gte")).toEqual(["u2", "u3"]);
    });

    it("sorts ascending, with nulls last ascending and first descending", async () => {
      await db.create("verification", verification("v1", t0, null));
      await db.create("verification", verification("v2", t0, new Date(t0.getTime() + 1000)));
      await db.create("verification", verification("v3", t0, t0));
      const order = async (dir: "asc" | "desc") =>
        (await db.findMany("verification", [], { sort: { field: "consumedAt", dir } })).map(
          (r) => r.id,
        );
      expect(await order("asc")).toEqual(["v3", "v2", "v1"]);
      expect(await order("desc")).toEqual(["v1", "v2", "v3"]);
    });

    it("enforces a composite unique key on identity", async () => {
      await db.create("identity", identity("i1", "github", "42", t0));
      await db.create("identity", identity("i2", "github", "43", t0));
      await db.create("identity", identity("i3", "google", "42", t0));
      await expect(db.create("identity", identity("i4", "github", "42", t0))).rejects.toMatchObject(
        {
          code: "unique_violation",
          model: "identity",
          fields: ["provider", "subject"],
        },
      );
    });

    it("round-trips an integer column", async () => {
      await db.create("passkey", passkey("p1", 7, t0));
      const row = await db.findOne("passkey", [{ field: "id", op: "eq", value: "p1" }]);
      expect(row?.counter).toBe(7);
      expect(row?.backedUp).toBe(false);
      await db.update("passkey", [{ field: "id", op: "eq", value: "p1" }], {
        counter: 8,
        backedUp: true,
      });
      const next = await db.findOne("passkey", [{ field: "id", op: "eq", value: "p1" }]);
      expect(next?.counter).toBe(8);
      expect(next?.backedUp).toBe(true);
    });

    it("rolls back an update when the function throws", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(
        db.transaction(async (tx) => {
          await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "changed" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const row = await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }]);
      expect(row?.name).toBeNull();
    });

    it("rolls back a delete when the function throws", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(
        db.transaction(async (tx) => {
          await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }])).not.toBeNull();
    });

    it("rolls back earlier writes after a unique violation inside a transaction", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(
        db.transaction(async (tx) => {
          await tx.create("user", user("u2", "b@example.com", t0));
          await tx.create("user", user("u3", "a@example.com", t0));
        }),
      ).rejects.toMatchObject({ code: "unique_violation" });
      const rows = await db.findMany("user", []);
      expect(rows.map((r) => r.id)).toEqual(["u1"]);
    });

    it("consumes a verification once when two conditional updates run together", async () => {
      await db.create("verification", verification("v1", t0, null));
      const consume = () =>
        db.update(
          "verification",
          [
            { field: "valueHash", op: "eq", value: "hash-v1" },
            { field: "consumedAt", op: "eq", value: null },
          ],
          { consumedAt: t0 },
        );
      const counts = await Promise.all([consume(), consume()]);
      expect(counts.sort()).toEqual([0, 1]);
    });

    it("rejects an unknown field in create data, update data, and sort", async () => {
      await expect(
        db.create("user", { ...user("u1", "a@example.com", t0), nope: 1 } as never),
      ).rejects.toMatchObject({
        code: "unknown_field",
      });
      await db.create("user", user("u1", "a@example.com", t0));
      await expect(
        db.update("user", [{ field: "id", op: "eq", value: "u1" }], { nope: 1 } as never),
      ).rejects.toMatchObject({ code: "unknown_field" });
      await expect(
        db.findMany("user", [], { sort: { field: "nope" as "id", dir: "asc" } }),
      ).rejects.toMatchObject({
        code: "unknown_field",
      });
    });
  });
}
