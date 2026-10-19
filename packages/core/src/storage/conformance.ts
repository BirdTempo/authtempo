import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../create-auth.js";
import type { SecretsRewrap } from "../engine/secrets.js";
import { decodeJws } from "../primitives/jwk.js";
import { base32Decode, totpCode } from "../primitives/totp.js";
import type { Result } from "../result.js";
import type {
  ApiTokenRow,
  IdentityRow,
  JwkRow,
  OAuthClientRow,
  OAuthConsentRow,
  OAuthDeviceRow,
  OAuthLogoutRow,
  OAuthSessionClientRow,
  OAuthSubjectRow,
  OAuthTokenRow,
  PasskeyRow,
  SecondFactorRow,
  SessionRow,
  TotpRow,
  TrustedDeviceRow,
  UserRow,
  VerificationRow,
} from "../schema.js";
import { createPbkdf2PasswordHash } from "../seams/password-hash.js";
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
    secretVersion: 1,
  };
}

/** A second-factor row of plan 12c, for the version tests (plan 12b). */
/**
 * The client fields of schema version 11 (plan 12e) as migration 0011 fills
 * them on a row of version 10: a public client with no secret.
 */
const PUBLIC_CLIENT_V11: Omit<
  OAuthClientRow,
  "id" | "createdAt" | "updatedAt" | "kind" | "name" | "redirectUris" | "lastSeenAt"
> = {
  authMethod: "none",
  secretHash: null,
  secretExpiresAt: null,
  previousSecretHash: null,
  previousSecretUntil: null,
  jwks: null,
  jwksUri: null,
  grantTypes: ["authorization_code", "refresh_token"],
  credentialsScopes: [],
  introspect: false,
  postLogoutRedirectUris: [],
  backchannelLogoutUri: null,
  backchannelLogoutSessionRequired: false,
  subjectType: "public",
  dpopBound: false,
};

function secondFactor(id: string, at: Date): Omit<SecondFactorRow, "secretVersion"> {
  return {
    id,
    userId: "u1",
    enabledAt: at,
    methods: ["totp"],
    backupCodes: ["h1"],
    backupCodesVersion: 2,
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
        secretVersion: 1,
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

    it("round-trips the version 7 jwk, oauthClient, oauthConsent, and oauthToken models and keeps their unique keys (plan 9g)", async () => {
      const at = new Date("2026-10-13T00:00:00.000Z");
      const key: JwkRow = {
        id: "k1",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "x1", kid: "k1", alg: "EdDSA", use: "sig" },
        privateKey: "sealed",
        slot: "signing",
        retiredAt: null,
        createdAt: at,
        updatedAt: at,
        secretVersion: 1,
      };
      await db.create("jwk", key);
      // One signing key: a second row in the slot conflicts; a retired row (slot null) does not.
      await expect(db.create("jwk", { ...key, id: "k2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["slot"],
      });
      const retire = [
        { field: "id" as const, op: "eq" as const, value: "k1" },
        { field: "slot" as const, op: "eq" as const, value: "signing" },
      ];
      expect(await db.update("jwk", retire, { slot: null, retiredAt: at })).toBe(1);
      expect(await db.update("jwk", retire, { slot: null, retiredAt: at })).toBe(0);
      await db.create("jwk", { ...key, id: "k2" });
      await db.create("jwk", {
        ...key,
        id: "k3",
        slot: null,
        retiredAt: new Date(at.getTime() - 1000),
      });
      expect(await db.findOne("jwk", [{ field: "id", op: "eq", value: "k1" }])).toEqual({
        ...key,
        slot: null,
        retiredAt: at,
      });
      expect(
        (await db.findMany("jwk", [{ field: "retiredAt", op: "lt", value: at }])).map((r) => r.id),
      ).toEqual(["k3"]);

      const client: OAuthClientRow = {
        id: "https://client.example.com/oauth/metadata.json",
        kind: "cimd",
        name: null,
        redirectUris: ["https://client.example.com/cb", "http://127.0.0.1:5173/cb"],
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
        ...PUBLIC_CLIENT_V11,
      };
      await db.create("oauthClient", client);
      await expect(db.create("oauthClient", client)).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["id"],
      });
      expect(
        await db.findOne("oauthClient", [{ field: "id", op: "eq", value: client.id }]),
      ).toEqual(client);

      const consent: OAuthConsentRow = {
        id: "c1",
        userId: "u1",
        clientId: client.id,
        scopes: ["openid", "mcp:read"],
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthConsent", consent);
      await expect(db.create("oauthConsent", { ...consent, id: "c2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["clientId", "userId"],
      });

      const token: OAuthTokenRow = {
        id: "t1",
        tokenHash: "h1",
        familyId: "f1",
        userId: "u1",
        clientId: client.id,
        scopes: ["offline_access"],
        resource: "https://api.example.com/mcp",
        expiresAt: new Date(at.getTime() + 1000),
        usedAt: null,
        parentId: null,
        dpopJkt: null,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthToken", token);
      await expect(db.create("oauthToken", { ...token, id: "t2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["tokenHash"],
      });
      await db.create("oauthToken", { ...token, id: "t3", tokenHash: "h3" });
      // The rotation guard: the second spend of one refresh token matches no row.
      const spend = [
        { field: "id" as const, op: "eq" as const, value: "t1" },
        { field: "usedAt" as const, op: "eq" as const, value: null },
      ];
      expect(await db.update("oauthToken", spend, { usedAt: at })).toBe(1);
      expect(await db.update("oauthToken", spend, { usedAt: at })).toBe(0);
      expect(
        await db.findOne("oauthToken", [{ field: "tokenHash", op: "eq", value: "h1" }]),
      ).toEqual({ ...token, usedAt: at });
      expect(await db.delete("oauthToken", [{ field: "familyId", op: "eq", value: "f1" }])).toBe(2);
    });

    it("round-trips the version 8 secondFactor model and keeps its unique key (plan 12c)", async () => {
      const at = new Date("2026-10-14T00:00:00.000Z");
      await db.create("user", user("u1", "a@example.com", at));
      const factor: SecondFactorRow = {
        id: "s1",
        userId: "u1",
        enabledAt: at,
        methods: ["totp"],
        backupCodes: ["h1", "h2"],
        backupCodesVersion: 1,
        createdAt: at,
        updatedAt: at,
        secretVersion: 1,
      };
      await db.create("secondFactor", factor);
      await expect(db.create("secondFactor", { ...factor, id: "s2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["userId"],
      });
      // The method and backup code writes are a compare-and-set on updatedAt: one winner.
      const later = new Date(at.getTime() + 1);
      const guard = [
        { field: "id" as const, op: "eq" as const, value: "s1" },
        { field: "updatedAt" as const, op: "eq" as const, value: at },
      ];
      const change = {
        methods: ["totp", "passkey"] as SecondFactorRow["methods"],
        backupCodes: ["h2"],
        backupCodesVersion: 2,
        updatedAt: later,
      };
      expect(await db.update("secondFactor", guard, change)).toBe(1);
      expect(await db.update("secondFactor", guard, change)).toBe(0);
      expect(
        await db.findOne("secondFactor", [{ field: "userId", op: "eq", value: "u1" }]),
      ).toEqual({ ...factor, ...change });
      expect(await db.delete("secondFactor", [{ field: "userId", op: "eq", value: "u1" }])).toBe(1);
    });

    it("writes and reads each new model with every field (plan 12e)", async () => {
      const at = new Date("2026-10-19T00:00:00.000Z");
      const later = new Date(at.getTime() + 60_000);
      const client: OAuthClientRow = {
        id: "cl_confidential",
        kind: "registered",
        name: "Billing",
        redirectUris: ["https://billing.example.com/cb"],
        lastSeenAt: at,
        authMethod: "private_key_jwt",
        secretHash: "s1",
        secretExpiresAt: later,
        previousSecretHash: "s0",
        previousSecretUntil: later,
        jwks: { keys: [{ kty: "EC", crv: "P-256", x: "x1", y: "y1", kid: "j1" }] },
        jwksUri: "https://billing.example.com/jwks.json",
        grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
        credentialsScopes: ["billing:read"],
        introspect: true,
        postLogoutRedirectUris: ["https://billing.example.com/bye"],
        backchannelLogoutUri: "https://billing.example.com/logout",
        backchannelLogoutSessionRequired: true,
        subjectType: "pairwise",
        dpopBound: true,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthClient", client);
      expect(
        await db.findOne("oauthClient", [{ field: "id", op: "eq", value: client.id }]),
      ).toEqual(client);
      const token: OAuthTokenRow = {
        id: "t2",
        tokenHash: "h2",
        familyId: "f1",
        userId: "u1",
        clientId: client.id,
        scopes: ["offline_access"],
        resource: "https://api.example.com/mcp",
        expiresAt: later,
        usedAt: null,
        parentId: "t1",
        dpopJkt: "jkt1",
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthToken", token);
      expect(
        await db.findOne("oauthToken", [{ field: "parentId", op: "eq", value: "t1" }]),
      ).toEqual(token);
      const device: OAuthDeviceRow = {
        id: "d1",
        deviceCodeHash: "dc1",
        userCodeHash: "uc1",
        secretVersion: 2,
        clientId: client.id,
        scopes: ["openid"],
        resource: "https://api.example.com/mcp",
        status: "approved",
        userId: "u1",
        sessionId: "s1",
        interval: 10,
        lastPolledAt: at,
        dpopJkt: "jkt1",
        expiresAt: later,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthDevice", device);
      expect(
        await db.findOne("oauthDevice", [{ field: "deviceCodeHash", op: "eq", value: "dc1" }]),
      ).toEqual(device);
      const subject: OAuthSubjectRow = {
        id: "p1",
        userId: "u1",
        sector: "billing.example.com",
        subject: "sub1",
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthSubject", subject);
      expect(
        await db.findOne("oauthSubject", [{ field: "subject", op: "eq", value: "sub1" }]),
      ).toEqual(subject);
      const link: OAuthSessionClientRow = {
        id: "l1",
        sessionId: "s1",
        clientId: client.id,
        userId: "u1",
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthSessionClient", link);
      expect(
        await db.findOne("oauthSessionClient", [{ field: "sessionId", op: "eq", value: "s1" }]),
      ).toEqual(link);
      const logout: OAuthLogoutRow = {
        id: "o1",
        clientId: client.id,
        userId: "u1",
        sessionId: "s1",
        attempts: 1,
        nextAttemptAt: later,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthLogout", logout);
      expect(
        await db.findMany("oauthLogout", [{ field: "nextAttemptAt", op: "lte", value: later }]),
      ).toEqual([logout]);
    });

    it("keeps one row per unique key of the new models (plan 12e)", async () => {
      const at = new Date("2026-10-19T00:00:00.000Z");
      const device: OAuthDeviceRow = {
        id: "d1",
        deviceCodeHash: "dc1",
        userCodeHash: "uc1",
        secretVersion: 1,
        clientId: "cl_1",
        scopes: [],
        resource: "https://api.example.com/mcp",
        status: "pending",
        userId: null,
        sessionId: null,
        interval: 5,
        lastPolledAt: null,
        dpopJkt: null,
        expiresAt: new Date(at.getTime() + 60_000),
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthDevice", device);
      await expect(
        db.create("oauthDevice", { ...device, id: "d2", userCodeHash: "uc2" }),
      ).rejects.toMatchObject({ code: "unique_violation", fields: ["deviceCodeHash"] });
      await expect(
        db.create("oauthDevice", { ...device, id: "d3", deviceCodeHash: "dc3" }),
      ).rejects.toMatchObject({ code: "unique_violation", fields: ["userCodeHash"] });

      const subject: OAuthSubjectRow = {
        id: "p1",
        userId: "u1",
        sector: "a.example.com",
        subject: "sub1",
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthSubject", subject);
      await expect(
        db.create("oauthSubject", { ...subject, id: "p2", subject: "sub2" }),
      ).rejects.toMatchObject({ code: "unique_violation", fields: ["sector", "userId"] });
      await expect(
        db.create("oauthSubject", { ...subject, id: "p3", sector: "b.example.com" }),
      ).rejects.toMatchObject({ code: "unique_violation", fields: ["subject"] });
      // Another sector of the same user is a second subject.
      await db.create("oauthSubject", {
        ...subject,
        id: "p4",
        sector: "b.example.com",
        subject: "sub4",
      });

      const link: OAuthSessionClientRow = {
        id: "l1",
        sessionId: "s1",
        clientId: "cl_1",
        userId: "u1",
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthSessionClient", link);
      await expect(db.create("oauthSessionClient", { ...link, id: "l2" })).rejects.toMatchObject({
        code: "unique_violation",
        fields: ["sessionId", "clientId"],
      });
      await db.create("oauthSessionClient", { ...link, id: "l3", clientId: "cl_2" });

      // The outbox has no unique key: two logouts of one session and client both stay.
      const logout: OAuthLogoutRow = {
        id: "o1",
        clientId: "cl_1",
        userId: "u1",
        sessionId: "s1",
        attempts: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("oauthLogout", logout);
      await db.create("oauthLogout", { ...logout, id: "o2" });
      expect(
        await db.findMany("oauthLogout", [{ field: "userId", op: "eq", value: "u1" }]),
      ).toHaveLength(2);
    });

    it("round-trips secretVersion on the four keyed models and filters by it (plan 12b)", async () => {
      const at = new Date("2026-10-14T00:00:00.000Z");
      await db.create("user", user("u1", "a@example.com", at));
      await db.create("verification", { ...verification("v1", at, null), secretVersion: 1 });
      await db.create("verification", { ...verification("v2", at, null), secretVersion: 2 });
      await db.create("totp", {
        id: "f1",
        userId: "u1",
        secret: "sealed",
        enabledAt: at,
        lastStep: 0,
        backupCodes: [],
        createdAt: at,
        updatedAt: at,
        secretVersion: 2,
      });
      await db.create("jwk", {
        id: "k1",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "x1", kid: "k1", alg: "EdDSA", use: "sig" },
        privateKey: "sealed",
        slot: "signing",
        retiredAt: null,
        createdAt: at,
        updatedAt: at,
        secretVersion: 3,
      });
      await db.create("secondFactor", { ...secondFactor("s1", at), secretVersion: 2 });
      expect(
        (
          await db.findMany("verification", [{ field: "secretVersion", op: "in", value: [2, 3] }])
        ).map((r) => r.id),
      ).toEqual(["v2"]);
      // The reseal guard: the second update of one old version matches no row.
      const reseal = [
        { field: "id" as const, op: "eq" as const, value: "f1" },
        { field: "secretVersion" as const, op: "eq" as const, value: 2 },
      ];
      expect(await db.update("totp", reseal, { secret: "resealed", secretVersion: 3 })).toBe(1);
      expect(await db.update("totp", reseal, { secret: "again", secretVersion: 3 })).toBe(0);
      expect(
        (await db.findOne("totp", [{ field: "id", op: "eq", value: "f1" }]))?.secretVersion,
      ).toBe(3);
      expect(
        (await db.findOne("jwk", [{ field: "id", op: "eq", value: "k1" }]))?.secretVersion,
      ).toBe(3);
      expect(
        (await db.findMany("secondFactor", [{ field: "secretVersion", op: "ne", value: 3 }])).map(
          (r) => r.id,
        ),
      ).toEqual(["s1"]);
      // The filter above also matches the column default 1, so read the value back.
      expect(
        (await db.findOne("secondFactor", [{ field: "id", op: "eq", value: "s1" }]))?.secretVersion,
      ).toBe(2);
    });

    it("round-trips the version 10 session freshAt, a null among them (plan 12a)", async () => {
      const at = new Date("2026-10-14T00:00:00.000Z");
      // A session names a user; the compatibility storage has a foreign key on it.
      await db.create("user", user("u-fresh", "fresh@example.com", at));
      const stale: SessionRow = {
        id: "s1",
        userId: "u-fresh",
        tokenHash: "h1",
        expiresAt: new Date(at.getTime() + 60_000),
        lastSeenAt: at,
        ip: null,
        userAgent: null,
        activeOrganizationId: null,
        freshAt: null,
        createdAt: at,
        updatedAt: at,
      };
      await db.create("session", stale);
      await db.create("session", { ...stale, id: "s2", tokenHash: "h2", freshAt: at });
      expect(await db.findOne("session", [{ field: "id", op: "eq", value: "s1" }])).toEqual(stale);
      expect(
        (await db.findMany("session", [{ field: "freshAt", op: "eq", value: null }])).map(
          (s) => s.id,
        ),
      ).toEqual(["s1"]);
      // The re-authentication's write: one live row by id.
      const later = new Date(at.getTime() + 1000);
      const live = [
        { field: "id" as const, op: "eq" as const, value: "s1" },
        { field: "expiresAt" as const, op: "gt" as const, value: later },
      ];
      expect(await db.update("session", live, { freshAt: later, updatedAt: later })).toBe(1);
      // The write keeps the token hash and the expiry: only freshAt and updatedAt move.
      expect(await db.findOne("session", [{ field: "id", op: "eq", value: "s1" }])).toEqual({
        ...stale,
        freshAt: later,
        updatedAt: later,
      });
      expect(
        (await db.findOne("session", [{ field: "id", op: "eq", value: "s2" }]))?.freshAt,
      ).toEqual(at);
    });
  });
}

/**
 * The rotation proof of plan 12b on one storage: a TOTP user, a backup
 * code, an email code, a session, and a session JWT, all made under
 * version 1, pass through the two-phase rotation of spec 22. After the
 * rewrap, version 1 goes, and the TOTP user and the JWT still pass. Call it
 * from an adapter's test file with a factory that opens a fresh database.
 */
export function runSecretRotationConformance(
  name: string,
  factory: () => Promise<ConformanceTarget>,
): void {
  describe(`secret rotation: ${name}`, () => {
    it("a rotation locks out no TOTP user and ends no live token (plan 12b)", async () => {
      const target = await factory();
      try {
        await rotationRun(target.adapter);
      } finally {
        await target.close();
      }
    });
  });
}

async function rotationRun(storage: StorageAdapter): Promise<void> {
  const S1 = "0123456789abcdef0123456789abcdef";
  const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
  const PW = "correct horse battery";
  const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
  let current = new Date("2026-10-14T00:00:00.000Z");
  const clock = { now: () => current };
  const step = () => {
    current = new Date(current.getTime() + 30_000);
  };
  const mail: string[] = [];
  const make = (secrets: Array<{ version: number; value: string }>) =>
    createAuth({
      baseURL: "https://api.example.com",
      trustedOrigins: [],
      storage,
      mail: {
        send: async (m) => {
          mail.push(m.text);
        },
      },
      clock,
      secrets,
      password: { hash: FAST },
    });
  const codeOf = (text: string | undefined) => /\b(\d{6})\b/.exec(text ?? "")?.[1] ?? "";
  const at = clock.now();
  const userId = "01JA0000000000000000000U02";
  await storage.create("user", {
    id: userId,
    email: "ada@example.com",
    emailVerified: true,
    name: null,
    image: null,
    createdAt: at,
    updatedAt: at,
  });
  await storage.create("password", {
    id: "01JA0000000000000000000P02",
    userId,
    hash: await FAST.hash(PW),
    createdAt: at,
    updatedAt: at,
  });
  // Version 1 alone: the factor on, a session, a session JWT, and a live email code of another address.
  const v1 = make([{ version: 1, value: S1 }]);
  must(await v1.api.emailOtp?.request({ email: "ada@example.com", ip: null }));
  const signedIn = must(
    await v1.api.emailOtp?.verify({
      email: "ada@example.com",
      code: codeOf(mail.at(-1)),
      ip: null,
      userAgent: null,
    }),
  );
  if (!("token" in signedIn)) throw new Error("rotation: no session token");
  const setup = must(await v1.api.totp?.setup({ userId, password: PW }));
  const seed = base32Decode(setup.secret);
  const session = await v1.api.getSession(signedIn.token);
  if (!session) throw new Error("rotation: no session");
  must(await v1.api.totp?.enable({ session, code: await totpCode(seed, clock.now()) }));
  const jwt = must(await v1.api.jwt?.mint({ userId, sessionId: session.session.id }));
  must(await v1.api.emailOtp?.request({ email: "bo@example.com", ip: null }));
  const boCode = codeOf(mail.at(-1));
  const passFactor = async (auth: ReturnType<typeof make>, backupCode?: string) => {
    const r = await auth.api.password?.signIn({
      email: "ada@example.com",
      password: PW,
      ip: null,
      userAgent: null,
    });
    if (!r?.ok || !("twoFactor" in r.value)) return false;
    const v = await auth.api.totp?.verify({
      challenge: r.value.twoFactor.challenge,
      ...(backupCode !== undefined ? { backupCode } : { code: await totpCode(seed, clock.now()) }),
      ip: null,
    });
    return v?.ok === true;
  };
  // Phase 1 knows version 2 and writes nothing under it; phase 2 makes it current.
  for (const secrets of [
    [
      { version: 1, value: S1 },
      { version: 2, value: S2 },
    ],
    [
      { version: 2, value: S2 },
      { version: 1, value: S1 },
    ],
  ]) {
    const auth = make(secrets);
    step();
    expect({ phase: secrets[0]?.version, totp: await passFactor(auth) }).toEqual({
      phase: secrets[0]?.version,
      totp: true,
    });
    expect(await auth.api.jwt?.verify(jwt.token)).not.toBeNull();
    expect(await auth.api.getSession(signedIn.token)).not.toBeNull();
  }
  const phase2 = make([
    { version: 2, value: S2 },
    { version: 1, value: S1 },
  ]);
  must(
    await phase2.api.emailOtp?.verify({
      email: "bo@example.com",
      code: boCode,
      ip: null,
      userAgent: null,
    }),
  );
  expect(await passFactor(phase2, setup.backupCodes[0])).toBe(true);
  // One pass of the rewrap: follow `next` to the end of the rows.
  let after: string | null = null;
  for (let round = 0; round < 10; round++) {
    const r: SecretsRewrap = must(
      await phase2.api.secrets.rewrap({ limit: 1, ...(after !== null ? { after } : {}) }),
    );
    expect({ failed: r.failed, skipped: r.skipped }).toEqual({ failed: 0, skipped: 0 });
    after = r.next;
    if (after === null) {
      expect(r.more).toBe(false);
      break;
    }
  }
  expect(after).toBeNull();
  const one = (await phase2.api.secrets.status()).versions.find((v) => v.version === 1);
  // The backup codes under version 1 stay until they are used or replaced: status shows them.
  expect(one).toEqual({
    version: 1,
    configured: true,
    current: false,
    totpSecrets: 0,
    backupCodes: setup.backupCodes.length - 1,
    signingKeys: 0,
    emailCodes: 0,
  });
  // Version 1 goes. The TOTP user and the JWT of version 1 still pass.
  const only2 = make([{ version: 2, value: S2 }]);
  step();
  expect(await passFactor(only2)).toBe(true);
  expect(await only2.api.jwt?.verify(jwt.token)).not.toBeNull();
  // The verify reads the public key only. A new token proves that the
  // resealed private key opens: a key that does not open retires at the
  // sign, and a new key with another kid signs.
  const again = must(await only2.api.jwt?.mint({ userId, sessionId: session.session.id }));
  expect(decodeJws(again.token)?.header.kid).toBe(decodeJws(jwt.token)?.header.kid);
}

/** The value of an ok result, or a throw that names the code. */
function must<T>(r: Result<T> | undefined): T {
  if (!r?.ok) throw new Error(`rotation: ${r ? r.code : "no api"}`);
  return r.value;
}
