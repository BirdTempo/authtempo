import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiTokenRow,
  IdentityRow,
  PasskeyRow,
  TotpRow,
  TrustedDeviceRow,
  UserRow,
  VerificationRow,
} from "../schema.js";
import { type StorageAdapter, StorageError } from "./port.js";

export interface ConformanceTarget {
  adapter: StorageAdapter;
  close(): Promise<void>;
}

export interface ConformanceOptions {
  /**
   * Models this storage does not hold. Only `apiToken` is allowed: the
   * Better Auth compatibility package holds no API token until its api-key
   * plan (plan 8b). The suite then checks the contract of a model with no
   * table: a read answers empty, as for a where that never matches, and a
   * create throws `unknown_model`.
   */
  unmapped?: readonly "apiToken"[];
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
  options: ConformanceOptions = {},
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
      // The parent first: a Better Auth table has a foreign key from account.userId (plan 9b).
      await db.create("user", user("u1", "a@example.com", t0));
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
      await db.create("user", user("u1", "a@example.com", t0));
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

    // The attempt count (plan 9e; `countAttempt` since plan 9f) is a compare-and-set on
    // `updatedAt`. It holds only if `eq` on a date matches the stored value
    // to the millisecond, on every adapter. An adapter that keeps whole
    // seconds, or shifts a zone, answers 0 here, and the count never lands.
    it("update with eq on a date matches the read value to the millisecond, and eq null on a nullable date matches only null (plan 9e)", async () => {
      const at = new Date(t0.getTime() + 123);
      await db.create("verification", verification("v1", at, null));
      await db.create("verification", verification("v2", at, at));
      const read = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
      if (!read) throw new Error("no row v1");
      expect(read.updatedAt.getTime()).toBe(at.getTime());
      const cas = (value: Date, data: Partial<VerificationRow>) =>
        db.update(
          "verification",
          [
            { field: "id", op: "eq", value: "v1" },
            { field: "updatedAt", op: "eq", value },
          ],
          data,
        );
      const later = new Date(at.getTime() + 1);
      expect(await cas(later, { data: { n: 9 } })).toBe(0);
      expect(await cas(new Date(at.getTime() - 1), { data: { n: 9 } })).toBe(0);
      expect(await cas(read.updatedAt, { data: { n: 2 }, updatedAt: later })).toBe(1);
      expect(await cas(read.updatedAt, { data: { n: 3 } })).toBe(0);
      const again = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
      expect(again?.data).toEqual({ n: 2 });
      expect(again?.updatedAt.getTime()).toBe(later.getTime());
      if (!again) throw new Error("no row v1");
      expect(await cas(again.updatedAt, { data: { n: 4 } })).toBe(1);
      const spend = await db.update(
        "verification",
        [
          { field: "id", op: "in", value: ["v1", "v2"] },
          { field: "consumedAt", op: "eq", value: null },
        ],
        { consumedAt: later },
      );
      expect(spend).toBe(1);
      const v2 = await db.findOne("verification", [{ field: "id", op: "eq", value: "v2" }]);
      expect(v2?.consumedAt?.getTime()).toBe(at.getTime());
      const v1 = await db.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]);
      expect(v1?.consumedAt?.getTime()).toBe(later.getTime());
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

    it("sorts by several keys in order, so id breaks a tie (plan 6)", async () => {
      const at = t0;
      await db.create("organization", {
        id: "o2",
        slug: "b",
        name: "Same",
        metadata: null,
        createdAt: at,
        updatedAt: at,
      });
      await db.create("organization", {
        id: "o1",
        slug: "a",
        name: "Same",
        metadata: { k: 1 },
        createdAt: at,
        updatedAt: at,
      });
      await db.create("organization", {
        id: "o3",
        slug: "c",
        name: "Other",
        metadata: null,
        createdAt: at,
        updatedAt: at,
      });
      const rows = await db.findMany("organization", [], {
        sort: [
          { field: "name", dir: "asc" },
          { field: "id", dir: "asc" },
        ],
      });
      expect(rows.map((r) => r.id)).toEqual(["o3", "o1", "o2"]);
      expect(rows[1]?.metadata).toEqual({ k: 1 });
    });

    it("applies each key's own direction, so an ascending id follows a descending name", async () => {
      const at = t0;
      for (const [id, name] of [
        ["o2", "Same"],
        ["o1", "Same"],
        ["o3", "Zed"],
      ] as const) {
        await db.create("organization", {
          id,
          slug: id,
          name,
          metadata: null,
          createdAt: at,
          updatedAt: at,
        });
      }
      const rows = await db.findMany("organization", [], {
        sort: [
          { field: "name", dir: "desc" },
          { field: "id", dir: "asc" },
        ],
      });
      expect(rows.map((r) => r.id)).toEqual(["o3", "o1", "o2"]);
    });

    it("round-trips the version 2 models and keeps their unique keys", async () => {
      const at = t0;
      await db.create("user", user("u1", "a@example.com", at));
      await db.create("organization", {
        id: "o1",
        slug: "o1",
        name: "O1",
        metadata: null,
        createdAt: at,
        updatedAt: at,
      });
      await db.create("member", {
        id: "m1",
        organizationId: "o1",
        userId: "u1",
        role: "owner",
        createdAt: at,
        updatedAt: at,
      });
      await expect(
        db.create("member", {
          id: "m2",
          organizationId: "o1",
          userId: "u1",
          role: "admin",
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["organizationId", "userId"],
      });
      await db.create("invitation", {
        id: "i1",
        organizationId: "o1",
        email: "b@example.com",
        role: "member",
        inviterId: "u1",
        tokenHash: "h1",
        expiresAt: new Date(at.getTime() + 1000),
        acceptedAt: null,
        createdAt: at,
        updatedAt: at,
      });
      const inv = await db.findOne("invitation", [{ field: "tokenHash", op: "eq", value: "h1" }]);
      expect(inv?.acceptedAt).toBeNull();
      expect(inv?.expiresAt.getTime()).toBe(at.getTime() + 1000);
    });

    it("round-trips the version 4 password model and keeps its unique key (plan 8)", async () => {
      const at = new Date("2026-10-10T00:00:00.000Z");
      await db.create("user", user("u1", "a@example.com", at));
      await db.create("password", {
        id: "p1",
        userId: "u1",
        hash: "pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        createdAt: at,
        updatedAt: at,
      });
      await expect(
        db.create("password", { id: "p2", userId: "u1", hash: "x", createdAt: at, updatedAt: at }),
      ).rejects.toMatchObject({ code: "unique_violation", fields: ["userId"] });
      const row = await db.findOne("password", [{ field: "userId", op: "eq", value: "u1" }]);
      expect(row?.hash.startsWith("pbkdf2-sha256$1000$")).toBe(true);
      expect(row?.createdAt.getTime()).toBe(at.getTime());
    });

    const apiToken = (at: Date): ApiTokenRow => ({
      id: "t1",
      userId: "u1",
      name: "ci",
      tokenHash: "h1",
      hint: "abcdefgh",
      expiresAt: null,
      lastUsedAt: null,
      organizationId: null,
      createdAt: at,
      updatedAt: at,
    });

    if (options.unmapped?.includes("apiToken")) {
      it("holds no apiToken row: reads answer empty and a create throws unknown_model (plan 8b)", async () => {
        const at = new Date("2026-10-11T00:00:00.000Z");
        await db.create("user", user("u1", "a@example.com", at));
        const byUser = [{ field: "userId" as const, op: "eq" as const, value: "u1" }];
        await expect(db.create("apiToken", apiToken(at))).rejects.toMatchObject({
          code: "unknown_model",
        });
        expect(await db.findOne("apiToken", byUser)).toBeNull();
        expect(await db.findMany("apiToken", byUser)).toEqual([]);
        expect(await db.update("apiToken", byUser, { lastUsedAt: at })).toBe(0);
        expect(await db.delete("apiToken", byUser)).toBe(0);
        expect(await db.transaction((tx) => tx.delete("apiToken", byUser))).toBe(0);
      });
    } else {
      it("round-trips the version 5 apiToken model and keeps its unique key (plan 8b)", async () => {
        const at = new Date("2026-10-11T00:00:00.000Z");
        await db.create("user", user("u1", "a@example.com", at));
        const row = apiToken(at);
        await db.create("apiToken", row);
        await expect(db.create("apiToken", { ...row, id: "t2" })).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["tokenHash"],
        });
        const later = new Date(at.getTime() + 3_600_000);
        expect(
          await db.update("apiToken", [{ field: "id", op: "eq", value: "t1" }], {
            lastUsedAt: later,
            expiresAt: later,
            organizationId: "o1",
          }),
        ).toBe(1);
        const back = await db.findOne("apiToken", [{ field: "tokenHash", op: "eq", value: "h1" }]);
        expect(back).toEqual({
          ...row,
          lastUsedAt: later,
          expiresAt: later,
          organizationId: "o1",
        });
        // A null expiry never matches lt, so the sweep keeps a token with no expiry.
        await db.create("apiToken", { ...apiToken(at), id: "t3", tokenHash: "h3" });
        expect(
          await db.delete("apiToken", [
            { field: "expiresAt", op: "lt", value: new Date(later.getTime() + 1) },
          ]),
        ).toBe(1);
        expect((await db.findMany("apiToken", [])).map((r) => r.id)).toEqual(["t3"]);
      });
    }
    it("round-trips the version 6 totp and trustedDevice models and keeps their unique keys (plan 9f)", async () => {
      const at = new Date("2026-10-13T00:00:00.000Z");
      await db.create("user", user("u1", "a@example.com", at));
      const factor: TotpRow = {
        id: "f1",
        userId: "u1",
        secret: "sealed",
        enabledAt: null,
        lastStep: 0,
        backupCodes: ["h1", "h2"],
        createdAt: at,
        updatedAt: at,
      };
      await db.create("totp", factor);
      await expect(db.create("totp", { ...factor, id: "f2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["userId"],
      });
      // A 30-second step of October 2025. The replay guard: the second update of one step matches no row.
      const step = 58_725_000;
      const guard = [
        { field: "id" as const, op: "eq" as const, value: "f1" },
        { field: "lastStep" as const, op: "lt" as const, value: step },
      ];
      expect(
        await db.update("totp", guard, { lastStep: step, enabledAt: at, backupCodes: ["h2"] }),
      ).toBe(1);
      expect(await db.update("totp", guard, { lastStep: step })).toBe(0);
      expect(await db.findOne("totp", [{ field: "userId", op: "eq", value: "u1" }])).toEqual({
        ...factor,
        lastStep: step,
        enabledAt: at,
        backupCodes: ["h2"],
      });
      expect(
        await db.findMany("totp", [{ field: "enabledAt", op: "ne", value: null }]),
      ).toHaveLength(1);
      const device: TrustedDeviceRow = {
        id: "d1",
        userId: "u1",
        tokenHash: "t1",
        expiresAt: new Date(at.getTime() + 1000),
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("trustedDevice", device);
      await expect(db.create("trustedDevice", { ...device, id: "d2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["tokenHash"],
      });
      await db.create("trustedDevice", {
        ...device,
        id: "d3",
        tokenHash: "t3",
        expiresAt: new Date(at.getTime() + 5000),
      });
      expect(
        await db.delete("trustedDevice", [
          { field: "expiresAt", op: "lt", value: new Date(at.getTime() + 2000) },
        ]),
      ).toBe(1);
      expect(
        (await db.findMany("trustedDevice", [{ field: "userId", op: "eq", value: "u1" }])).map(
          (r) => r.id,
        ),
      ).toEqual(["d3"]);
    });
  });
}
