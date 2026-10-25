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
  ModelName,
  Models,
  OAuthClientRow,
  OAuthConsentRow,
  OAuthDeviceRow,
  OAuthLogoutRow,
  OAuthSessionClientRow,
  OAuthSubjectRow,
  OAuthTokenRow,
  OperatorAuditRow,
  OrganizationRoleRow,
  OrganizationTokenRow,
  PasskeyRow,
  ScimGroupMemberRow,
  ScimGroupRow,
  ScimTokenRow,
  ScimUserRow,
  SecondFactorRow,
  SessionRow,
  SsoConnectionRow,
  SsoDomainRow,
  TeamMemberRow,
  TeamRow,
  TotpRow,
  TrustedDeviceRow,
  UserRow,
  VerificationRow,
} from "../schema.js";
import { schema } from "../schema.js";
import { createPbkdf2PasswordHash } from "../seams/password-hash.js";
import { type Sort, type StorageAdapter, StorageError, type Where } from "./port.js";
import { USER_CHILD_MODELS } from "./sql.js";

export { runRefreshRaceConformance } from "./refresh-race-conformance.js";

export interface ConformanceTarget {
  adapter: StorageAdapter;
  close(): Promise<void>;
  /**
   * Optional. Ends the connection of the adapter, as a database that stops:
   * the next call of the adapter throws. `close` still cleans up after it.
   * The suite holds `ping` to a fresh read with it (plan 12h Task 8).
   */
  stop?(): Promise<void>;
}

/**
 * The models that a storage may leave out. The Better Auth compatibility
 * package holds no API token until its api-key plan (plan 8b). It holds none
 * of the four models of plan 12k until the 12k shim tasks map them.
 */
export type UnmappedModel =
  | "apiToken"
  | "organizationRole"
  | "team"
  | "teamMember"
  | "organizationToken";

export interface ConformanceOptions {
  /**
   * Models this storage does not hold. The suite then checks the contract
   * of a model with no table. A read answers empty, as for a where that
   * never matches. A create throws `unknown_model`.
   */
  unmapped?: readonly UnmappedModel[];
  /**
   * True for an adapter on a database with row locks, such as Postgres. It
   * must then have `lockInOrder` (ruling 37 of plan 12f): without it two
   * flows that delete many sessions can wait on each other. Default false.
   */
  rowLocks?: boolean;
  /**
   * True for an adapter that must have `ping` (plan 12h Task 8). The ping
   * row passes when an adapter has no `ping`, so this option holds the
   * method to the adapter. Default false.
   */
  ping?: boolean;
  /**
   * The statements of one update inside a transaction, for `statementsSent`.
   * D1 sends 2: the read of the rows for the undo and the write. Default 1.
   */
  updateInTransaction?: number;
  /**
   * The statements of one `ping`, for `statementsSent` (plan 12h Task 8).
   * The D1 storage of the Better Auth tables also reads the indexes of the
   * account table, so it sends more. Default 1.
   */
  pingStatements?: number;
  /**
   * Opens a store whose migrations stop at the version before
   * `SCHEMA_VERSION` (plan 12h Task 8). An app has such a store before it
   * runs the new migration. With it, the suite holds `ping` to
   * `schema_mismatch` there. An adapter with no schema version, such as
   * memory, leaves it out.
   */
  oldStore?: () => Promise<ConformanceTarget>;
  /**
   * The statements of one `lockInOrder` inside a transaction, for
   * `statementsSent`. MySQL sends 2: the read of the ids and the lock by id
   * (ruling 2 of plan 12g). Default 1.
   */
  lockStatements?: number;
  /**
   * False for a storage whose user table needs an address in every row and
   * has no form for a null. The suite then holds that a create with no
   * address fails with a StorageError. Default true (schema version 15).
   * The Better Auth tables keep the default since plan 12i Task 16. The
   * compat storage writes a placeholder for a null and reads it back as null.
   */
  nullEmail?: boolean;
}

function user(id: string, email: string, at: Date): UserRow {
  return {
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
  };
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

/** A second-factor row of plan 12c, for the version tests (plan 12b). */
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
    discoverable: null,
    prf: false,
    largeBlob: false,
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

    // Schema version 15 (plan 12i): an address, a username, and a phone are
    // each unique and each nullable. A null never conflicts, as in SQL.
    const KEYS = [
      ["email", "a@example.com", "b@example.com"],
      ["username", "ada", "bob"],
      ["phone", "+14155550100", "+14155550101"],
    ] as const;
    for (const [field, value, other] of KEYS) {
      const keyed = (id: string, v: string | null): UserRow => ({
        ...user(id, `${id}@example.com`, t0),
        [field]: v,
      });
      it(`two null values coexist under the unique key of user ${field}`, async () => {
        if (field === "email" && options.nullEmail === false) {
          // This storage holds an address in every row: a create with none fails
          // with invalid_argument before any statement runs (ruling 15 of plan 12i).
          await expect(db.create("user", keyed("u1", null))).rejects.toBeInstanceOf(StorageError);
          await expect(db.create("user", keyed("u1", null))).rejects.toMatchObject({
            code: "invalid_argument",
            model: "user",
          });
          expect(await db.findMany("user", [])).toEqual([]);
          return;
        }
        await db.create("user", keyed("u1", null));
        await db.create("user", keyed("u2", null));
        await db.create("user", keyed("u3", other));
        const nulls = await db.findMany("user", [{ field, op: "eq", value: null }]);
        expect(nulls.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
        for (const r of nulls) expect(r[field]).toBeNull();
      });
      it(`a second equal non-null value of user ${field} fails`, async () => {
        await db.create("user", keyed("u1", value));
        await expect(db.create("user", keyed("u2", value))).rejects.toMatchObject({
          name: "StorageError",
          code: "unique_violation",
          model: "user",
        });
        await db.create("user", keyed("u3", other));
        await expect(
          db.update("user", [{ field: "id", op: "eq", value: "u3" }], { [field]: value }),
        ).rejects.toMatchObject({ name: "StorageError", code: "unique_violation" });
        expect((await db.findMany("user", [{ field, op: "eq", value }])).map((r) => r.id)).toEqual([
          "u1",
        ]);
      });
    }

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

    it("limit 0 returns nothing, and a limit that is not a non-negative safe integer throws", async () => {
      await db.create("user", user("u1", "a@example.com", t0));
      expect(await db.findMany("user", [], { limit: 0 })).toEqual([]);
      // The largest safe integer is a limit. One rule on every store (ruling 7 of plan 12g):
      // MySQL inlines the limit, and 1e21 prints as "1e+21".
      expect(await db.findMany("user", [], { limit: 9007199254740991 })).toHaveLength(1);
      for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, 9007199254740992]) {
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

    it("keeps two values that differ only in case apart (plan 12g)", async () => {
      // The engine lowers each address before a write, so the users test the
      // storage rule, not the engine rule: storage compares bytes. A MySQL
      // column with a case-blind collation would fail it.
      await db.create("user", user("u1", "a@example.com", t0));
      await db.create("user", user("u2", "A@example.com", t0));
      await db.create("passkey", { ...passkey("p1", 1, t0), credentialId: "cred-AbC" });
      await db.create("passkey", { ...passkey("p2", 1, t0), credentialId: "cred-abc" });
      expect(await db.findMany("user", [])).toHaveLength(2);
      expect(await db.findMany("passkey", [])).toHaveLength(2);
      const byCredential = async (value: string) =>
        (await db.findOne("passkey", [{ field: "credentialId", op: "eq", value }]))?.id;
      expect(await byCredential("cred-AbC")).toBe("p1");
      expect(await byCredential("cred-abc")).toBe("p2");
      const byEmail = async (value: string) =>
        (await db.findOne("user", [{ field: "email", op: "eq", value }]))?.id;
      expect(await byEmail("a@example.com")).toBe("u1");
      expect(await byEmail("A@example.com")).toBe("u2");
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

    it("sorts a notNull key as a plain key, and refuses notNull on a nullable field (ruling 27 of plan 12i)", async () => {
      const later = new Date(t0.getTime() + 1000);
      await db.create("user", user("u2", "b@example.com", later));
      await db.create("user", user("u1", "a@example.com", later));
      await db.create("user", user("u3", "c@example.com", t0));
      const ids = async (dir: "asc" | "desc") =>
        (
          await db.findMany("user", [], {
            sort: [
              { field: "createdAt", dir, notNull: true },
              { field: "id", dir: "asc", notNull: true },
            ],
          })
        ).map((r) => r.id);
      expect(await ids("asc")).toEqual(["u3", "u1", "u2"]);
      expect(await ids("desc")).toEqual(["u1", "u2", "u3"]);
      await expect(
        db.findMany("user", [], {
          sort: { field: "name", dir: "asc", notNull: true } as Sort<"user">,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument", fields: ["name"] });
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
        teamIds: null,
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
      permissions: null,
      metadata: null,
      rateLimitSeconds: null,
      rateLimitMax: null,
      remaining: null,
      refillAmount: null,
      refillSeconds: null,
      lastRefillAt: null,
      retiredAt: null,
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
        sid: "s1",
        issuer: "https://b.example/auth",
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
        sid: "s1",
        attempts: 1,
        nextAttemptAt: later,
        issuer: "https://b.example/auth",
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
        sid: "s1",
        issuer: null,
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
        sid: "s1",
        attempts: 0,
        nextAttemptAt: at,
        issuer: null,
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
        actorId: null,
        activeTeamId: null,
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

    describe("schema version 12 round-trips (plan 12f)", () => {
      const at = new Date("2026-10-20T00:00:00.000Z");

      it("round-trips the ban fields of a user, set and null", async () => {
        const banned: UserRow = {
          ...user("u-banned", "banned@example.com", at),
          bannedAt: at,
          banReason: "abuse of the support desk",
          banUntil: new Date(at.getTime() + 86_400_000),
        };
        const free = user("u-free", "free@example.com", at);
        await db.create("user", banned);
        await db.create("user", free);
        expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u-banned" }])).toEqual(
          banned,
        );
        const read = await db.findOne("user", [{ field: "id", op: "eq", value: "u-free" }]);
        expect(read).toEqual(free);
        expect(read).toMatchObject({ bannedAt: null, banReason: null, banUntil: null });
      });

      it("round-trips the actor of a session", async () => {
        // A session names a user; the compatibility storage has a foreign key on it.
        await db.create("user", user("u-target", "target@example.com", at));
        const row: SessionRow = {
          id: "s-imp",
          userId: "u-target",
          tokenHash: "h-imp",
          expiresAt: new Date(at.getTime() + 60_000),
          lastSeenAt: at,
          ip: null,
          userAgent: null,
          activeOrganizationId: null,
          freshAt: null,
          actorId: "u-operator",
          activeTeamId: null,
          createdAt: at,
          updatedAt: at,
        };
        await db.create("session", row);
        expect(await db.findOne("session", [{ field: "id", op: "eq", value: "s-imp" }])).toEqual(
          row,
        );
      });

      it("round-trips an operatorAudit row and reads the rows of one target in id order", async () => {
        const first: OperatorAuditRow = {
          id: "a1",
          actorKind: "secret",
          actorId: "support",
          action: "ban",
          targetUserId: "u-target",
          reason: "abuse of the support desk",
          data: { until: "2026-10-21T00:00:00.000Z", nested: { n: 1, ok: true } },
          ip: null,
          userAgent: null,
          createdAt: at,
          updatedAt: at,
        };
        const second: OperatorAuditRow = {
          ...first,
          id: "a2",
          actorKind: "user",
          actorId: "u-operator",
          action: "unban",
          data: null,
          ip: "203.0.113.7",
          userAgent: "curl/8.0",
        };
        const all: OperatorAuditRow = {
          ...first,
          id: "a3",
          action: "sessions_end_all",
          targetUserId: null,
          data: { ended: 2, more: false },
        };
        // Out of id order, so the sort and not the insert order decides.
        await db.create("operatorAudit", second);
        await db.create("operatorAudit", all);
        await db.create("operatorAudit", first);
        expect(await db.findOne("operatorAudit", [{ field: "id", op: "eq", value: "a1" }])).toEqual(
          first,
        );
        expect(
          await db.findMany(
            "operatorAudit",
            [{ field: "targetUserId", op: "eq", value: "u-target" }],
            {
              sort: [{ field: "id", dir: "asc" }],
            },
          ),
        ).toEqual([first, second]);
        expect(
          (
            await db.findMany("operatorAudit", [{ field: "targetUserId", op: "eq", value: null }])
          ).map((r) => r.id),
        ).toEqual(["a3"]);
      });
    });

    describe("where values that no ascii key of MySQL holds (ruling 9 of plan 12g)", () => {
      // A non-ASCII value, a control character, and a trailing space can come
      // from input, such as an id cursor. MySQL refuses the first two in an
      // ascii column, and ascii_bin ignores a trailing space. Every store
      // answers as Postgres and D1 do, by the stored values. The ids are in
      // byte order; "a b" holds an inner space.
      const IDS = ["a", "a b", "ab", "b", "~"];
      const seed = async () => {
        for (const [i, id] of IDS.entries())
          await db.create("user", user(id, `u${i}@example.com`, t0));
      };
      const ids = async (op: Where<"user">["op"], value: unknown) =>
        (
          await db.findMany("user", [{ field: "id", op, value }], {
            sort: { field: "id", dir: "asc" },
          })
        ).map((r) => r.id);

      it("answers eq, ne, and in by the stored values", async () => {
        await seed();
        expect(await ids("eq", "é")).toEqual([]);
        expect(await ids("eq", "a ")).toEqual([]);
        expect(await db.findOne("user", [{ field: "id", op: "eq", value: "a " }])).toBeNull();
        expect(await ids("ne", "é")).toEqual(IDS);
        expect(await ids("ne", "a ")).toEqual(IDS);
        expect(await ids("in", ["a", "é", "b "])).toEqual(["a"]);
        expect(await ids("in", ["é"])).toEqual([]);
      });

      it("answers startsWith by the stored values", async () => {
        await seed();
        expect(await ids("startsWith", "é")).toEqual([]);
        expect(await ids("startsWith", "a\u0001")).toEqual([]);
        expect(await ids("startsWith", "a ")).toEqual(["a b"]);
      });

      it("answers lt, lte, gt, and gte in byte order", async () => {
        await seed();
        expect(await ids("lt", "aé")).toEqual(["a", "a b", "ab"]);
        expect(await ids("lte", "aé")).toEqual(["a", "a b", "ab"]);
        expect(await ids("gt", "aé")).toEqual(["b", "~"]);
        expect(await ids("gte", "aé")).toEqual(["b", "~"]);
        expect(await ids("gt", "~é")).toEqual([]);
        expect(await ids("lt", "~é")).toEqual(IDS);
        expect(await ids("lt", "a ")).toEqual(["a"]);
        expect(await ids("lte", "a ")).toEqual(["a"]);
        expect(await ids("gt", "a ")).toEqual(["a b", "ab", "b", "~"]);
        expect(await ids("gte", "a ")).toEqual(["a b", "ab", "b", "~"]);
        expect(await ids("lt", "a\u0001")).toEqual(["a"]);
        expect(await ids("gte", "a\u0001")).toEqual(["a b", "ab", "b", "~"]);
      });

      it("updates and deletes the rows of the same answer", async () => {
        await seed();
        expect(
          await db.update("user", [{ field: "id", op: "eq", value: "a " }], { name: "x" }),
        ).toBe(0);
        expect(
          await db.update("user", [{ field: "id", op: "lt", value: "aé" }], { name: "y" }),
        ).toBe(3);
        const named = await db.findMany("user", [{ field: "name", op: "eq", value: "y" }], {
          sort: { field: "id", dir: "asc" },
        });
        expect(named.map((r) => r.id)).toEqual(["a", "a b", "ab"]);
        expect(await db.delete("user", [{ field: "id", op: "eq", value: "é" }])).toBe(0);
        expect(await db.delete("user", [{ field: "id", op: "startsWith", value: "a " }])).toBe(1);
        expect(await db.delete("user", [{ field: "id", op: "ne", value: "b " }])).toBe(4);
        expect(await db.findMany("user", [])).toEqual([]);
      });

      it("refuses a NUL and a lone surrogate in each clause (rulings 16 and 17)", async () => {
        // Core refuses both in every where value, so no store may answer rows
        // for them. libSQL over HTTP failed a lone surrogate with HTTP 400.
        await seed();
        const refused = { name: "StorageError", code: "invalid_argument" };
        const OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "startsWith"] as const;
        for (const value of ["a\u0000", "a\uD800", "\uDC00b"]) {
          for (const op of OPS) await expect(ids(op, value)).rejects.toMatchObject(refused);
          await expect(ids("in", [value, "b"])).rejects.toMatchObject(refused);
          // A field that is not ascii on MySQL takes the same rule.
          await expect(
            db.findMany("user", [{ field: "email", op: "eq", value }]),
          ).rejects.toMatchObject(refused);
        }
        await expect(
          db.findOne("user", [{ field: "id", op: "eq", value: "\uD800" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.update("user", [{ field: "id", op: "lt", value: "a\uD800" }], { name: "x" }),
        ).rejects.toMatchObject(refused);
        await expect(
          db.delete("user", [{ field: "id", op: "ne", value: "\uDC00b" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.findOne("user", [{ field: "id", op: "eq", value: "\u0000" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.update("user", [{ field: "id", op: "eq", value: "a\u0000" }], { name: "x" }),
        ).rejects.toMatchObject(refused);
        await expect(
          db.delete("user", [{ field: "id", op: "ne", value: "a\u0000" }]),
        ).rejects.toMatchObject(refused);
        const rows = await db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
        expect(rows.map((r) => [r.id, r.name])).toEqual(IDS.map((id) => [id, null]));
      });
    });

    describe("startsWith (plan 12f)", () => {
      const rows: [string, string][] = [
        ["p1", "a%b@example.com"],
        ["p2", "abc@example.com"],
        ["p3", "a_c@example.com"],
        ["p4", "a\\d@example.com"],
        ["p5", "éa@example.com"],
        ["p6", "ébc@example.com"],
        ["p7", "Abe@example.com"],
        ["p8", "𝔞b@example.com"],
      ];
      const prefixed = async (prefix: string) =>
        (await db.findMany("user", [{ field: "email", op: "startsWith", value: prefix }]))
          .map((r) => r.id)
          .sort();

      beforeEach(async () => {
        for (const [id, email] of rows) await db.create("user", user(id, email, t0));
      });

      it("matches a prefix as text, with no wildcard and with case", async () => {
        expect(await prefixed("a%")).toEqual(["p1"]);
        expect(await prefixed("a_")).toEqual(["p3"]);
        expect(await prefixed("a\\")).toEqual(["p4"]);
        expect(await prefixed("ab")).toEqual(["p2"]);
        expect(await prefixed("A")).toEqual(["p7"]);
        expect(await prefixed("a")).toEqual(["p1", "p2", "p3", "p4"]);
        expect(await prefixed("é")).toEqual(["p5", "p6"]);
        expect(await prefixed("éa")).toEqual(["p5"]);
        // One code point outside the BMP: two UTF-16 units, one character in SQL.
        expect(await prefixed("𝔞")).toEqual(["p8"]);
        expect(await prefixed("abc@example.com")).toEqual(["p2"]);
        expect(await prefixed("abc@example.comx")).toEqual([]);
      });

      it("joins with the other clauses and the sort", async () => {
        // The sort is on id: p1, p3, and p4 differ in one digit, so no collation changes the
        // order. Punctuation in an email sorts differently on glibc, ICU, and byte order.
        const found = await db.findMany(
          "user",
          [
            { field: "email", op: "startsWith", value: "a" },
            { field: "email", op: "ne", value: "abc@example.com" },
          ],
          { sort: [{ field: "id", dir: "desc" }], limit: 2 },
        );
        expect(found.map((r) => r.id)).toEqual(["p4", "p3"]);
      });

      it("never matches null", async () => {
        await db.create("user", { ...user("n1", "n1@example.com", t0), name: "xena" });
        await db.create("user", user("n2", "n2@example.com", t0));
        const found = await db.findMany("user", [{ field: "name", op: "startsWith", value: "x" }]);
        expect(found.map((r) => r.id)).toEqual(["n1"]);
      });

      it("refuses an empty prefix, a value that is not a string, and a field that is not a string", async () => {
        const refused = { name: "StorageError", code: "invalid_argument" };
        await expect(
          db.findMany("user", [{ field: "email", op: "startsWith", value: "" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.findMany("user", [{ field: "email", op: "startsWith", value: 5 }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.findMany("user", [{ field: "email", op: "startsWith", value: null }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.findMany("user", [{ field: "emailVerified", op: "startsWith", value: "t" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.findMany("user", [{ field: "createdAt", op: "startsWith", value: "2026" }]),
        ).rejects.toMatchObject(refused);
        // A lone surrogate is no code point: memory, Postgres, and SQLite gave three answers.
        await expect(
          db.findMany("user", [{ field: "email", op: "startsWith", value: "\uD835" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.findMany("user", [{ field: "email", op: "startsWith", value: "a\uDD1E" }]),
        ).rejects.toMatchObject(refused);
        // NUL: the SQL codec refuses it in every string, and memory does the same.
        await expect(
          db.findMany("user", [{ field: "email", op: "startsWith", value: "a\u0000" }]),
        ).rejects.toMatchObject(refused);
        // The refusal holds on an empty table too, and on update and delete.
        await expect(
          db.findMany("session", [{ field: "id", op: "startsWith", value: "" }]),
        ).rejects.toMatchObject(refused);
        await expect(
          db.update("user", [{ field: "email", op: "startsWith", value: "" }], { name: "x" }),
        ).rejects.toMatchObject(refused);
        await expect(
          db.delete("user", [{ field: "email", op: "startsWith", value: 5 }]),
        ).rejects.toMatchObject(refused);
        expect((await db.findMany("user", [])).length).toBe(8);
      });
    });

    describe("the optional methods of the call budget (rulings 35 to 37 of plan 12f)", () => {
      /** The growth of `statementsSent` across `step`. */
      const growth = async (step: () => Promise<unknown>) => {
        const before = db.statementsSent?.() ?? 0;
        await step();
        return (db.statementsSent?.() ?? 0) - before;
      };

      it("counts each statement of each port call in statementsSent, inside a transaction too", async () => {
        if (!db.statementsSent) return;
        // The ready check first, so the counts below hold the calls alone.
        await db.findOne("user", [{ field: "id", op: "eq", value: "none" }]);
        const byId = [{ field: "id" as const, op: "eq" as const, value: "u1" }];
        const outside = [
          await growth(() => db.create("user", user("u1", "a@example.com", t0))),
          await growth(() => db.findOne("user", byId)),
          await growth(() => db.findMany("user", byId)),
          await growth(() => db.update("user", byId, { name: "Ada" })),
          await growth(() => db.delete("user", byId)),
        ];
        expect(outside).toEqual([1, 1, 1, 1, 1]);
        const inside: number[] = [];
        await db.transaction(async (tx) => {
          const step = async (f: () => Promise<unknown>) => {
            inside.push(await growth(f));
          };
          await step(() => tx.create("user", user("u2", "b@example.com", t0)));
          await step(() => tx.findOne("user", [{ field: "id", op: "eq", value: "u2" }]));
          await step(() => tx.findMany("user", [{ field: "id", op: "eq", value: "u2" }]));
          await step(() =>
            tx.update("user", [{ field: "id", op: "eq", value: "u2" }], { name: "Bea" }),
          );
          await step(() => tx.delete("user", [{ field: "id", op: "eq", value: "u2" }]));
        });
        // The transaction shares the count of the adapter, so a call budget sees each statement.
        expect(inside).toEqual([1, 1, 1, options.updateInTransaction ?? 1, 1]);
      });

      it("answers readyStatements once the check ran, and sends no statement for a second answer", async () => {
        if (!db.readyStatements) return;
        const first = await db.readyStatements();
        expect(Number.isInteger(first) && first >= 0).toBe(true);
        expect(await growth(async () => expect(await db.readyStatements?.()).toBe(first))).toBe(0);
      });

      it("has ping when the target says it must", () => {
        if (options.ping) expect(typeof db.ping).toBe("function");
      });

      it("ping answers for a ready store and throws schema_mismatch for an old one", async () => {
        if (!db.ping) return;
        // The cached check passes first. A ping that reads that cache sends no statement.
        await db.findOne("user", [{ field: "id", op: "eq", value: "none" }]);
        const ready = await db.readyStatements?.();
        expect(await growth(() => db.ping?.() ?? Promise.resolve())).toBe(
          options.pingStatements ?? 1,
        );
        expect(await growth(() => db.ping?.() ?? Promise.resolve())).toBe(
          options.pingStatements ?? 1,
        );
        // The ping leaves the cached check alone.
        expect(await db.readyStatements?.()).toBe(ready);
        if (options.oldStore) {
          const old = await options.oldStore();
          try {
            await expect(old.adapter.ping?.()).rejects.toMatchObject({
              name: "StorageError",
              code: "schema_mismatch",
            });
          } finally {
            await old.close();
          }
        }
        // The cached check passed above. After the database stops, a ping reads again, so it throws.
        if (target.stop) {
          await target.stop();
          await expect(db.ping?.()).rejects.toThrow();
        }
      });

      it("has lockInOrder on a database with row locks", () => {
        if (options.rowLocks) expect(typeof db.lockInOrder).toBe("function");
      });

      it("takes the row locks of lockInOrder in a transaction: a write of another caller waits for the commit", async () => {
        if (!db.lockInOrder) return;
        await db.create("user", user("u1", "a@example.com", t0));
        await db.create("user", user("u2", "b@example.com", t0));
        const all = [{ field: "email" as const, op: "ne" as const, value: "none" }];
        // Outside a transaction it holds nothing and changes nothing.
        await db.lockInOrder("user", all);
        const order: string[] = [];
        let locked: () => void = () => {};
        const held = new Promise<void>((r) => {
          locked = r;
        });
        const holder = db.transaction(async (tx) => {
          expect(await growth(() => tx.lockInOrder?.("user", all) ?? Promise.resolve())).toBe(
            options.lockStatements ?? 1,
          );
          locked();
          await new Promise((r) => setTimeout(r, 300));
          order.push("commit");
        });
        await held;
        const writer = db
          .update("user", [{ field: "id", op: "eq", value: "u2" }], { name: "Bea" })
          .then(() => order.push("write"));
        await Promise.all([holder, writer]);
        expect(order).toEqual(["commit", "write"]);
        const rows = await db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
        expect(rows.map((r) => [r.id, r.name])).toEqual([
          ["u1", null],
          ["u2", "Bea"],
        ]);
      });

      it("takes the row locks of lockInOrder by id, so a caller that locks in id order cannot deadlock with it", async () => {
        if (!db.lockInOrder) return;
        // The scan order differs from the id order: u2 goes in first, and the update writes a new
        // u1 row after it. So a lock in scan order takes u2 first (review m2 of the 12f Task 7 fix 2).
        await db.create("user", user("u2", "b@example.com", t0));
        await db.create("user", user("u1", "a@example.com", t0));
        await db.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ada" });
        const all = [{ field: "email" as const, op: "ne" as const, value: "none" }];
        const order: string[] = [];
        let first: () => void = () => {};
        const holdsFirst = new Promise<void>((r) => {
          first = r;
        });
        // The writer locks u1 and then u2, in id order.
        const writer = db.transaction(async (tx) => {
          await tx.update("user", [{ field: "id", op: "eq", value: "u1" }], { name: "Ann" });
          first();
          await new Promise((r) => setTimeout(r, 300));
          await tx.update("user", [{ field: "id", op: "eq", value: "u2" }], { name: "Bea" });
          order.push("writer");
        });
        await holdsFirst;
        // A lock by id waits on u1 and holds no row. A lock in scan order holds u2 and waits on u1,
        // while the writer waits on u2: a deadlock, and the database ends one transaction.
        const locker = db.transaction(async (tx) => {
          await tx.lockInOrder?.("user", all);
          order.push("locker");
        });
        await Promise.all([writer, locker]);
        expect(order).toEqual(["writer", "locker"]);
        const rows = await db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
        expect(rows.map((r) => [r.id, r.name])).toEqual([
          ["u1", "Ann"],
          ["u2", "Bea"],
        ]);
      });
    });

    describe("createMany (ruling 57 of plan 12d)", () => {
      const at = new Date("2026-10-24T00:00:00.000Z");
      /** `n` member rows of group `g`, ids `<g>-<i>` in order. */
      const members = (g: string, n: number, from = 0): ScimGroupMemberRow[] =>
        Array.from({ length: n }, (_, k) => {
          const i = String(from + k).padStart(6, "0");
          return {
            id: `${g}-${i}`,
            groupId: g,
            scimUserId: `su-${i}`,
            createdAt: at,
            updatedAt: at,
          };
        });
      const ofGroup = (g: string) =>
        db.findMany("scimGroupMember", [{ field: "groupId", op: "eq", value: g }], {
          sort: { field: "id", dir: "asc" },
        });
      /** The growth of `statementsSent` across `step`, or null with no counter. */
      const growth = async (step: () => Promise<unknown>) => {
        const before = db.statementsSent?.();
        await step();
        const after = db.statementsSent?.();
        return before === undefined || after === undefined ? null : after - before;
      };
      const counted = (n: number) => (db.statementsSent ? n : null);

      it("answers an empty list with no row and no statement", async () => {
        // The ready check first, so the count below holds the call alone.
        await db.findOne("user", [{ field: "id", op: "eq", value: "none" }]);
        let out: unknown;
        expect(
          await growth(async () => {
            out = await db.createMany("scimGroupMember", []);
          }),
        ).toBe(counted(0));
        expect(out).toEqual([]);
        expect(await db.findMany("scimGroupMember", [])).toEqual([]);
      });

      it("writes one row in one statement and answers it", async () => {
        await db.findOne("user", [{ field: "id", op: "eq", value: "none" }]);
        const [row] = members("g1", 1);
        let out: unknown;
        expect(
          await growth(async () => {
            out = await db.createMany("scimGroupMember", members("g1", 1));
          }),
        ).toBe(counted(1));
        expect(out).toEqual([row]);
        expect(await ofGroup("g1")).toEqual([row]);
      });

      it("writes a full chunk in one statement and one row more in two", async () => {
        const size = db.rowsPerInsert("scimGroupMember");
        // From 1 to 1000 rows: a larger statement ran a MySQL test server out of memory.
        expect(Number.isSafeInteger(size) && size >= 1 && size <= 1000).toBe(true);
        await db.findOne("user", [{ field: "id", op: "eq", value: "none" }]);
        expect(await growth(() => db.createMany("scimGroupMember", members("g1", size)))).toBe(
          counted(1),
        );
        expect(await growth(() => db.createMany("scimGroupMember", members("g2", size + 1)))).toBe(
          counted(2),
        );
        expect(await ofGroup("g1")).toEqual(members("g1", size));
        expect(await ofGroup("g2")).toEqual(members("g2", size + 1));
      });

      it("writes a full chunk of team member rows, with the columns that a storage adds, in one statement or two halves", async () => {
        if (options.unmapped?.some((m) => m === "team" || m === "teamMember")) return;
        // The Better Auth tables add a key column to a team member row, so its chunk is smaller.
        const size = db.rowsPerInsert("teamMember");
        const ids = Array.from({ length: size }, (_, i) => `u-${String(i).padStart(6, "0")}`);
        // The parents first: a storage with foreign keys (the Better Auth tables) needs them.
        await db.createMany(
          "user",
          ids.map((id) => user(id, `${id}@example.com`, at)),
        );
        await db.create("organization", {
          id: "o1",
          slug: "o1",
          name: "O",
          metadata: null,
          createdAt: at,
          updatedAt: at,
        });
        await db.create("team", {
          id: "t1",
          organizationId: "o1",
          name: "Ops",
          createdAt: at,
          updatedAt: at,
        });
        const rows: TeamMemberRow[] = ids.map((userId, i) => ({
          id: `tm-${String(i).padStart(6, "0")}`,
          teamId: "t1",
          organizationId: "o1",
          userId,
          createdAt: at,
          updatedAt: at,
        }));
        // The key column of the Better Auth tables makes a chunk of 1000 rows pass 100 KB on
        // SQLite, so it splits in two halves there (ruling 84 of plan 12d).
        const sent = await growth(() => db.createMany("teamMember", rows));
        if (sent !== null) expect([1, 2]).toContain(sent);
        expect(
          await db.findMany("teamMember", [{ field: "teamId", op: "eq", value: "t1" }], {
            sort: { field: "id", dir: "asc" },
          }),
        ).toEqual(rows);
      });

      it("writes no row of the call when the last row of the second chunk breaks a unique key", async () => {
        const size = db.rowsPerInsert("scimGroupMember");
        const [stored] = members("g1", 1, size);
        if (!stored) throw new Error("no row");
        await db.create("scimGroupMember", { ...stored, id: "kept" });
        // The last row holds the pair (groupId, scimUserId) of the stored row.
        await expect(
          db.createMany("scimGroupMember", members("g1", size + 1)),
        ).rejects.toMatchObject({
          name: "StorageError",
          code: "unique_violation",
          model: "scimGroupMember",
        });
        expect((await ofGroup("g1")).map((r) => r.id)).toEqual(["kept"]);
      });

      it("writes no row when two rows of the list share an id", async () => {
        const [a, b] = members("g1", 2);
        if (!a || !b) throw new Error("no row");
        await expect(
          db.createMany("scimGroupMember", [a, { ...b, id: a.id }]),
        ).rejects.toMatchObject({ name: "StorageError", code: "unique_violation" });
        expect(await ofGroup("g1")).toEqual([]);
      });

      it("rolls back its rows with the transaction, and an earlier write with them", async () => {
        const size = db.rowsPerInsert("scimGroupMember");
        await expect(
          db.transaction(async (tx) => {
            await tx.create("user", user("u1", "a@example.com", at));
            const out = await tx.createMany("scimGroupMember", members("g1", size + 1));
            expect(out).toHaveLength(size + 1);
            expect(await tx.findMany("scimGroupMember", [])).toHaveLength(size + 1);
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await db.findMany("scimGroupMember", [])).toEqual([]);
        expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }])).toBeNull();
      });

      it("fails a transaction with a unique clash of a later chunk and keeps no row of it", async () => {
        const size = db.rowsPerInsert("scimGroupMember");
        const [stored] = members("g1", 1, size);
        if (!stored) throw new Error("no row");
        await db.create("scimGroupMember", { ...stored, id: "kept" });
        await expect(
          db.transaction(async (tx) => {
            await tx.create("user", user("u1", "a@example.com", at));
            await tx.createMany("scimGroupMember", members("g1", size + 1));
          }),
        ).rejects.toMatchObject({ name: "StorageError", code: "unique_violation" });
        expect((await ofGroup("g1")).map((r) => r.id)).toEqual(["kept"]);
        expect(await db.findOne("user", [{ field: "id", op: "eq", value: "u1" }])).toBeNull();
      });

      it("rejects an unknown model and an unknown field, and writes nothing", async () => {
        const [row] = members("g1", 1);
        await expect(db.createMany("nope" as ModelName, [row] as never[])).rejects.toMatchObject({
          name: "StorageError",
          code: "unknown_model",
        });
        await expect(
          db.createMany("scimGroupMember", [{ ...row, nope: 1 } as unknown as ScimGroupMemberRow]),
        ).rejects.toMatchObject({ name: "StorageError", code: "unknown_field" });
        expect(await ofGroup("g1")).toEqual([]);
      });
    });

    describe("lists of up to 1000 values (ruling 84 of plan 12d)", () => {
      const at = new Date("2026-10-24T00:00:00.000Z");
      const later = new Date(at.getTime() + 60_000);
      /** `n` member rows of group `g`, with a scimUserId of `width` characters. */
      const members = (g: string, n: number, width = 9): ScimGroupMemberRow[] =>
        Array.from({ length: n }, (_, k) => {
          const i = String(k).padStart(6, "0");
          return {
            id: `${g}-${i}`,
            groupId: g,
            scimUserId: `su-${i}`.padEnd(width, "x"),
            createdAt: at,
            updatedAt: at,
          };
        });
      const growth = async (step: () => Promise<unknown>) => {
        const before = db.statementsSent?.();
        await step();
        const after = db.statementsSent?.();
        return before === undefined || after === undefined ? null : after - before;
      };
      const counted = (n: number) => (db.statementsSent ? n : null);

      it("reads, updates, and deletes by an in list of 1000 values in one statement each", async () => {
        const rows = members("g1", 1000);
        await db.createMany("scimGroupMember", rows);
        const ids = rows.map((r) => r.id);
        const inIds = [{ field: "id" as const, op: "in" as const, value: ids }];
        let found: ScimGroupMemberRow[] = [];
        expect(
          await growth(async () => {
            found = await db.findMany("scimGroupMember", inIds);
          }),
        ).toBe(counted(1));
        expect(found).toHaveLength(1000);
        let changed = 0;
        expect(
          await growth(async () => {
            changed = await db.update("scimGroupMember", inIds, { updatedAt: later });
          }),
        ).toBe(counted(1));
        expect(changed).toBe(1000);
        let gone = 0;
        expect(
          await growth(async () => {
            gone = await db.delete("scimGroupMember", [
              { field: "id", op: "in", value: ids.slice(0, 999) },
            ]);
          }),
        ).toBe(counted(1));
        expect(gone).toBe(999);
        const left = await db.findMany("scimGroupMember", []);
        expect(left.map((r) => [r.id, r.updatedAt.getTime()])).toEqual([
          ["g1-000999", later.getTime()],
        ]);
      });

      it("reads, updates, and deletes by an in list of 2000 values in one statement each (ruling 85 of plan 12d)", async () => {
        const rows = [...members("g1", 1000), ...members("g2", 1000)];
        await db.createMany("scimGroupMember", rows.slice(0, 1000));
        await db.createMany("scimGroupMember", rows.slice(1000));
        const inIds = [{ field: "id" as const, op: "in" as const, value: rows.map((r) => r.id) }];
        let found: ScimGroupMemberRow[] = [];
        expect(
          await growth(async () => {
            found = await db.findMany("scimGroupMember", inIds);
          }),
        ).toBe(counted(1));
        expect(found).toHaveLength(2000);
        expect(
          await growth(async () => {
            expect(await db.update("scimGroupMember", inIds, { updatedAt: later })).toBe(2000);
          }),
        ).toBe(counted(1));
        expect(
          await growth(async () => {
            expect(await db.delete("scimGroupMember", inIds)).toBe(2000);
          }),
        ).toBe(counted(1));
        expect(await db.findMany("scimGroupMember", [])).toEqual([]);
      });

      it("keeps each value of a long in list bound: quotes, brackets, and SQL text match only their own row", async () => {
        const odd = [
          "x') OR 1=1 --",
          'y"] OR 1=1 --',
          "z'; DELETE FROM ta_scim_group_member; --",
          "\\u0027 OR '1'='1",
          "[1, 2]",
        ];
        const rows = [...members("g1", 60), ...members("g2", 2)].map((r, i) => {
          const id = odd[i] ?? r.id;
          return { ...r, id };
        });
        await db.createMany("scimGroupMember", rows);
        // 58 values: more than 50, so a D1 or SQLite store binds the list as one JSON text.
        const wanted = [
          ...odd,
          ...rows.slice(odd.length, 55).map((r) => r.id),
          "none",
          "' OR ''='",
          // A where value only: an ascii column of MySQL holds no such id.
          "ü-ß-東京",
        ];
        const found = await db.findMany("scimGroupMember", [
          { field: "id", op: "in", value: wanted },
        ]);
        expect(found.map((r) => r.id).sort()).toEqual(
          rows
            .slice(0, 55)
            .map((r) => r.id)
            .sort(),
        );
        expect(await db.findMany("scimGroupMember", [])).toHaveLength(62);
      });

      it("writes 1000 rows of long values in one call and reads each back", async () => {
        // A scimUserId of 64 characters, the width of the column on MySQL: about 115 KB of
        // values. A D1 statement holds at most 100 KB, so D1 splits the call.
        const rows = members("g1", 1000, 64);
        expect(await db.createMany("scimGroupMember", rows)).toEqual(rows);
        expect(
          await db.findMany("scimGroupMember", [], { sort: { field: "id", dir: "asc" } }),
        ).toEqual(rows);
      });

      it("rolls back an update and a delete of 1000 rows each with the transaction", async () => {
        const users = Array.from({ length: 1000 }, (_, i) => {
          const id = `u-${String(i).padStart(6, "0")}`;
          return user(id, `${id}@example.com`, at);
        });
        await db.createMany("user", users);
        const ids = users.map((u) => u.id);
        const all = () => db.findMany("user", [], { sort: { field: "id", dir: "asc" } });
        const before = await all();
        await expect(
          db.transaction(async (tx) => {
            const inIds = [{ field: "id" as const, op: "in" as const, value: ids }];
            expect(await tx.update("user", inIds, { name: "changed", updatedAt: later })).toBe(
              1000,
            );
            expect(await tx.delete("user", inIds)).toBe(1000);
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await all()).toEqual(before);
      });
    });

    describe("schema version 13 (plan 12k)", () => {
      const at = new Date("2026-10-20T00:00:00.000Z");
      const later = new Date(at.getTime() + 3_600_000);
      const unmapped = (...models: UnmappedModel[]) =>
        models.filter((m) => options.unmapped?.includes(m));
      // The contract of a model with no table (plan 8b): a read answers empty, and a create throws unknown_model.
      async function holdsNone<M extends ModelName>(model: M, row: Models[M]): Promise<void> {
        const byId = [{ field: "id" as const, op: "eq" as const, value: row.id }];
        await expect(db.create(model, row)).rejects.toMatchObject({ code: "unknown_model" });
        expect(await db.findOne(model, byId)).toBeNull();
        expect(await db.findMany(model, byId)).toEqual([]);
        expect(await db.delete(model, byId)).toBe(0);
      }
      const role: OrganizationRoleRow = {
        id: "r1",
        organizationId: "o1",
        name: "auditor",
        rank: 1,
        permissions: { project: ["read"], member: ["read", "list"] },
        createdAt: at,
        updatedAt: at,
      };
      const team: TeamRow = {
        id: "t1",
        organizationId: "o1",
        name: "Ops",
        createdAt: at,
        updatedAt: at,
      };
      const teamMember: TeamMemberRow = {
        id: "tm1",
        teamId: "t1",
        organizationId: "o1",
        userId: "u1",
        createdAt: at,
        updatedAt: at,
      };
      const bare: OrganizationTokenRow = {
        id: "ot1",
        organizationId: "o1",
        createdById: "u1",
        name: "deploy",
        tokenHash: "oh1",
        hint: "abcdefgh",
        permissions: {},
        metadata: null,
        expiresAt: null,
        lastUsedAt: null,
        rateLimitSeconds: null,
        rateLimitMax: null,
        remaining: null,
        refillAmount: null,
        refillSeconds: null,
        lastRefillAt: null,
        retiredAt: null,
        createdAt: at,
        updatedAt: at,
      };
      const full: OrganizationTokenRow = {
        ...bare,
        id: "ot2",
        tokenHash: "oh2",
        permissions: { project: ["read", "write"] },
        metadata: { app: "ci", nested: { n: 1, ok: true } },
        expiresAt: later,
        lastUsedAt: at,
        rateLimitSeconds: 60,
        rateLimitMax: 100,
        remaining: 5000,
        refillAmount: 5000,
        refillSeconds: 86_400,
        lastRefillAt: at,
        retiredAt: later,
      };
      const token = (id: string, tokenHash: string): ApiTokenRow => ({
        ...apiToken(at),
        id,
        tokenHash,
      });

      it("round-trips an organization role with its json permissions", async () => {
        if (unmapped("organizationRole").length > 0) return holdsNone("organizationRole", role);
        // Its organization first: a storage with foreign keys (the Better Auth tables) needs the parent row.
        await db.create("organization", {
          id: "o1",
          slug: "o1",
          name: "O",
          metadata: null,
          createdAt: at,
          updatedAt: at,
        });
        await db.create("organizationRole", role);
        const where = [
          { field: "organizationId" as const, op: "eq" as const, value: "o1" },
          { field: "name" as const, op: "eq" as const, value: "auditor" },
        ];
        expect(await db.findOne("organizationRole", where)).toEqual(role);
        const second = { ...role, id: "r2", rank: 2 };
        await expect(db.create("organizationRole", second)).rejects.toBeInstanceOf(StorageError);
        await expect(db.create("organizationRole", second)).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["organizationId", "name"],
        });
      });

      it("round-trips a team and a team member", async () => {
        const none = unmapped("team", "teamMember");
        if (none.includes("team")) await holdsNone("team", team);
        if (none.includes("teamMember")) await holdsNone("teamMember", teamMember);
        if (none.length > 0) return;
        await db.create("user", user("u1", "a@example.com", at));
        // Its organization first: a storage with foreign keys (the Better Auth tables) needs the parent row.
        await db.create("organization", {
          id: "o1",
          slug: "o1",
          name: "O",
          metadata: null,
          createdAt: at,
          updatedAt: at,
        });
        await db.create("team", team);
        await db.create("teamMember", teamMember);
        expect(await db.findOne("team", [{ field: "id", op: "eq", value: "t1" }])).toEqual(team);
        await expect(db.create("teamMember", { ...teamMember, id: "tm2" })).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["teamId", "userId"],
        });
        expect(
          await db.findMany("teamMember", [
            { field: "organizationId", op: "eq", value: "o1" },
            { field: "userId", op: "eq", value: "u1" },
          ]),
        ).toEqual([teamMember]);
      });

      it("round-trips an organization token with every nullable field null and set", async () => {
        if (unmapped("organizationToken").length > 0) return holdsNone("organizationToken", bare);
        await db.create("organizationToken", bare);
        await db.create("organizationToken", full);
        const byHash = (h: string) => [
          { field: "tokenHash" as const, op: "eq" as const, value: h },
        ];
        expect(await db.findOne("organizationToken", byHash("oh1"))).toEqual(bare);
        expect(await db.findOne("organizationToken", byHash("oh2"))).toEqual(full);
        await expect(db.create("organizationToken", { ...bare, id: "ot3" })).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["tokenHash"],
        });
      });

      it("round-trips a moved token record and keeps one per source key", async () => {
        const record = {
          id: "mt1",
          source: "better-auth:apikey",
          sourceId: "k1",
          tokenId: "t1",
          createdAt: at,
          updatedAt: at,
        };
        await db.create("movedToken", record);
        // The same key id of another source is another record.
        await db.create("movedToken", { ...record, id: "mt2", source: "other:key" });
        expect(
          await db.findOne("movedToken", [
            { field: "source", op: "eq", value: "better-auth:apikey" },
            { field: "sourceId", op: "eq", value: "k1" },
          ]),
        ).toEqual(record);
        await expect(
          db.create("movedToken", { ...record, id: "mt3", tokenId: "t2" }),
        ).rejects.toMatchObject({ code: "unique_violation", fields: ["source", "sourceId"] });
      });

      it("round-trips the new api token fields as null", async () => {
        if (unmapped("apiToken").length > 0) return holdsNone("apiToken", token("t1", "h1"));
        // A row with the version 13 fields null reads them back as null. The
        // schema-v13 test of each adapter reads an old row.
        await db.create("user", user("u1", "a@example.com", at));
        await db.create("apiToken", token("t1", "h1"));
        const read = await db.findOne("apiToken", [{ field: "id", op: "eq", value: "t1" }]);
        expect(read).toEqual(token("t1", "h1"));
        expect(read).toMatchObject({
          permissions: null,
          metadata: null,
          remaining: null,
          retiredAt: null,
        });
      });

      it("matches a null retiredAt with eq null", async () => {
        if (unmapped("apiToken").length > 0) return holdsNone("apiToken", token("t1", "h1"));
        await db.create("user", user("u1", "a@example.com", at));
        const retired: ApiTokenRow = {
          ...token("t2", "h2"),
          permissions: { project: ["read"] },
          metadata: { moved: true },
          rateLimitSeconds: 60,
          rateLimitMax: 10,
          remaining: 0,
          refillAmount: 10,
          refillSeconds: 3600,
          lastRefillAt: at,
          retiredAt: later,
        };
        await db.create("apiToken", token("t1", "h1"));
        await db.create("apiToken", retired);
        await db.create("apiToken", token("t3", "h3"));
        expect(
          (
            await db.findMany("apiToken", [{ field: "retiredAt", op: "eq", value: null }], {
              sort: { field: "id", dir: "asc" },
            })
          ).map((r) => r.id),
        ).toEqual(["t1", "t3"]);
        expect(await db.findOne("apiToken", [{ field: "id", op: "eq", value: "t2" }])).toEqual(
          retired,
        );
      });

      it("lists teamMember and not organizationToken as a user child", () => {
        expect(USER_CHILD_MODELS).toContain("teamMember");
        expect(USER_CHILD_MODELS).toContain("apiToken");
        expect(USER_CHILD_MODELS).not.toContain("organizationToken");
        expect(USER_CHILD_MODELS).not.toContain("organizationRole");
        expect(USER_CHILD_MODELS).not.toContain("team");
      });
    });

    describe("SSO and SCIM models (plan 12d)", () => {
      const at = new Date("2026-10-21T00:00:00.000Z");
      const later = new Date(at.getTime() + 3_600_000);
      const connection: SsoConnectionRow = {
        id: "c1",
        organizationId: "o1",
        kind: "oidc",
        label: "Acme IdP",
        enabled: true,
        jit: false,
        defaultRole: "member",
        config: { issuer: "https://idp.acme.example", scopes: ["openid", "email"] },
        clientSecret: "sealed-1",
        secretVersion: 1,
        mfa: { amr: ["mfa"], acr: [] },
        scimRoles: { Admins: "admin" },
        createdAt: at,
        updatedAt: at,
      };
      const domain = (id: string, organizationId: string): SsoDomainRow => ({
        id,
        organizationId,
        domain: "acme.example",
        challenge: `challenge-${id}`,
        claimedDomain: null,
        connectionId: null,
        enforce: false,
        includeSubdomains: false,
        verifiedAt: null,
        checkedAt: null,
        failures: 0,
        firstFailureAt: null,
        expiresAt: later,
        createdAt: at,
        updatedAt: at,
      });
      const scimToken: ScimTokenRow = {
        id: "st1",
        organizationId: "o1",
        name: "Entra",
        tokenHash: "sh1",
        hint: "abcdefgh",
        scopes: ["scim.users.read", "scim.groups.write"],
        expiresAt: later,
        lastUsedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      const scimUser = (
        id: string,
        organizationId: string,
        userId: string,
        userNameKey: string,
      ): ScimUserRow => ({
        id,
        organizationId,
        userId,
        userName: userNameKey.toUpperCase(),
        userNameKey,
        externalId: `ext-${id}`,
        active: true,
        displayName: null,
        data: { name: { givenName: "Ada" }, emails: [{ value: userNameKey, primary: true }] },
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const scimGroup: ScimGroupRow = {
        id: "sg1",
        organizationId: "o1",
        displayName: "Admins",
        displayNameKey: "admins",
        externalId: null,
        teamId: "t1",
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      const scimGroupMember: ScimGroupMemberRow = {
        id: "sgm1",
        groupId: "sg1",
        scimUserId: "su1",
        createdAt: at,
        updatedAt: at,
      };
      const samlRow = (id: string, purpose: VerificationRow["purpose"]): VerificationRow => ({
        id,
        purpose,
        identifier: "c1",
        valueHash: `saml-${purpose}`,
        expiresAt: later,
        consumedAt: null,
        data: null,
        createdAt: at,
        updatedAt: at,
        secretVersion: 1,
      });
      const byId = (id: string) => [{ field: "id" as const, op: "eq" as const, value: id }];

      it("round-trips the six models", async () => {
        const claimed: SsoDomainRow = {
          ...domain("d1", "o1"),
          claimedDomain: "acme.example",
          connectionId: "c1",
          enforce: true,
          includeSubdomains: true,
          verifiedAt: at,
          checkedAt: later,
          failures: 2,
          firstFailureAt: at,
          expiresAt: null,
        };
        const bare: SsoConnectionRow = {
          ...connection,
          id: "c2",
          kind: "saml",
          enabled: false,
          jit: true,
          config: {},
          clientSecret: null,
          secretVersion: 3,
          mfa: null,
          scimRoles: null,
        };
        const user1 = scimUser("su1", "o1", "u1", "ada@acme.example");
        const user2: ScimUserRow = {
          ...scimUser("su2", "o1", "u2", "bob@acme.example"),
          externalId: null,
          active: false,
          displayName: "Bob",
          data: {},
          version: 7,
        };
        await db.create("ssoConnection", connection);
        await db.create("ssoConnection", bare);
        await db.create("ssoDomain", claimed);
        await db.create("ssoDomain", domain("d2", "o2"));
        await db.create("scimToken", scimToken);
        await db.create("scimUser", user1);
        await db.create("scimUser", user2);
        await db.create("scimGroup", scimGroup);
        await db.create("scimGroupMember", scimGroupMember);
        // toEqual reads a Date by its time, so each date reads back as the same epoch milliseconds.
        expect(await db.findOne("ssoConnection", byId("c1"))).toEqual(connection);
        expect(await db.findOne("ssoConnection", byId("c2"))).toEqual(bare);
        expect(await db.findOne("ssoDomain", byId("d1"))).toEqual(claimed);
        expect(await db.findOne("ssoDomain", byId("d2"))).toEqual(domain("d2", "o2"));
        expect((await db.findOne("ssoDomain", byId("d1")))?.firstFailureAt?.getTime()).toBe(
          at.getTime(),
        );
        expect(await db.findOne("scimToken", byId("st1"))).toEqual(scimToken);
        expect(await db.findOne("scimUser", byId("su1"))).toEqual(user1);
        expect(await db.findOne("scimUser", byId("su2"))).toEqual(user2);
        expect(await db.findOne("scimGroup", byId("sg1"))).toEqual(scimGroup);
        expect(await db.findOne("scimGroupMember", byId("sgm1"))).toEqual(scimGroupMember);
        await expect(
          db.create("scimGroupMember", { ...scimGroupMember, id: "sgm2" }),
        ).rejects.toMatchObject({ code: "unique_violation", fields: ["groupId", "scimUserId"] });
        await expect(db.create("scimToken", { ...scimToken, id: "st2" })).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["tokenHash"],
        });
      });

      it("keeps one organization per claimed domain", async () => {
        await db.create("ssoDomain", domain("d1", "o1"));
        await db.create("ssoDomain", domain("d2", "o2"));
        const claim = (id: string) =>
          db.update("ssoDomain", [...byId(id), { field: "claimedDomain", op: "eq", value: null }], {
            claimedDomain: "acme.example",
            verifiedAt: at,
          });
        expect(await claim("d1")).toBe(1);
        await expect(claim("d2")).rejects.toBeInstanceOf(StorageError);
        await expect(claim("d2")).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["claimedDomain"],
        });
        expect((await db.findOne("ssoDomain", byId("d2")))?.claimedDomain).toBeNull();
      });

      it("refuses a second userName key in one organization", async () => {
        await db.create("scimUser", scimUser("su1", "o1", "u1", "ada@acme.example"));
        await expect(
          db.create("scimUser", scimUser("su2", "o1", "u2", "ada@acme.example")),
        ).rejects.toMatchObject({
          code: "unique_violation",
          fields: ["organizationId", "userNameKey"],
        });
        await db.create("scimUser", scimUser("su3", "o2", "u2", "ada@acme.example"));
        expect(
          (
            await db.findMany("scimUser", [
              { field: "userNameKey", op: "eq", value: "ada@acme.example" },
            ])
          )
            .map((r) => r.id)
            .sort(),
        ).toEqual(["su1", "su3"]);
      });

      it("spends a version once", async () => {
        await db.create("scimUser", scimUser("su1", "o1", "u1", "ada@acme.example"));
        const spend = () =>
          db.update("scimUser", [...byId("su1"), { field: "version", op: "eq", value: 1 }], {
            version: 2,
            active: false,
          });
        expect(await spend()).toBe(1);
        expect(await spend()).toBe(0);
        expect(await db.findOne("scimUser", byId("su1"))).toMatchObject({
          version: 2,
          active: false,
        });
      });

      it("spends a saml-request row once", async () => {
        await db.create("verification", samlRow("v1", "saml-request"));
        const spend = () =>
          db.update(
            "verification",
            [...byId("v1"), { field: "consumedAt", op: "eq", value: null }],
            { consumedAt: later },
          );
        expect(await spend()).toBe(1);
        expect(await spend()).toBe(0);
        expect((await db.findOne("verification", byId("v1")))?.purpose).toBe("saml-request");
      });

      it("refuses a second saml-assertion row with one valueHash", async () => {
        await db.create("verification", samlRow("v1", "saml-assertion"));
        await expect(
          db.create("verification", samlRow("v2", "saml-assertion")),
        ).rejects.toMatchObject({ code: "unique_violation", fields: ["valueHash"] });
        expect(
          await db.findMany("verification", [
            { field: "purpose", op: "eq", value: "saml-assertion" },
          ]),
        ).toHaveLength(1);
      });
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
    ssoClientSecrets: 0,
    stateData: 0,
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

/** One SQLite store for `runStoredFormConformance`: the adapter and a raw read of its database. */
export interface StoredFormTarget {
  adapter: StorageAdapter;
  /** The rows of one SQL read on the database, as the driver answers them. */
  all(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface StoredFormOptions {
  /**
   * Models whose rows other rows name by a foreign key. Their rows go in
   * first, and the undo row does not delete them, because a delete cascades
   * to the rows that name them. Default: none.
   */
  parents?: readonly ModelName[];
  /**
   * False for a store whose user table needs an address in every row (see
   * `ConformanceOptions.nullEmail`). The row of nulls then keeps its
   * address. Default true.
   */
  nullEmail?: boolean;
}

/** Values that a column type can read back in another form: numbers, JSON, keywords, and spaces. */
const STORED_TEXTS = (r: number) => [
  `1234${r}`,
  `1.50${r}`,
  `{"a":${r}}`,
  `[${r}]`,
  `-0${r}`,
  `${r}e3`,
  `true${r}`,
  `null ${r}`,
  ` 4${r} `,
  `東京-${r}-😀`,
];

/**
 * Row `r` of `model` with a value of each type in each field. A field that
 * names a parent row names row `r` of that parent. With `nulls`, each
 * nullable field is null, but the user address when `keepEmail` is set.
 * `prefix` starts each free text.
 */
function storedRow(model: ModelName, r: number, nulls: boolean, prefix = "", keepEmail = false) {
  const fields = schema[model].fields as Record<
    string,
    { type: string; nullable?: boolean; int64?: true }
  >;
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [f, def] of Object.entries(fields)) {
    i++;
    if (f === "id") out[f] = `id-${model}-${r}`;
    else if (f === "userId" || f === "inviterId" || f === "actorId") out[f] = `id-user-${r}`;
    else if (f === "organizationId" || f === "activeOrganizationId")
      out[f] = `id-organization-${r}`;
    else if (f === "teamId" || f === "activeTeamId") out[f] = `id-team-${r}`;
    else if (nulls && def.nullable && !(keepEmail && model === "user" && f === "email"))
      out[f] = null;
    else if (model === "invitation" && f === "teamIds") out[f] = [`id-team-${r}`];
    else if (model === "organizationRole" && f === "permissions") out[f] = { project: ["read"] };
    else if (model === "passkey" && f === "publicKey") out[f] = "AQID-_";
    else if (model === "identity" && f === "provider") out[f] = `github${r}`;
    else if (def.type === "string") out[f] = `${prefix}${STORED_TEXTS(r)[i % 10]}`;
    else if (def.type === "integer") out[f] = def.int64 ? Number.MAX_SAFE_INTEGER - r : 7 + r;
    else if (def.type === "boolean") out[f] = r % 2 === 0;
    else if (def.type === "date") out[f] = new Date(1761264000123 + r * 1001);
    else out[f] = { k: `v"q\\${r}`, n: 1.5, big: 1e21, arr: [1, "2", null, true, { z: "東" }] };
  }
  return out;
}

/**
 * The stored form of each row on D1 and on each SQLite driver (rulings 84
 * and 85 of plan 12d). `createMany` binds its rows as one JSON list, and
 * `create` binds one parameter per value. Both must store the same type and
 * the same bytes in each column. Else a compare such as `expiresAt > now`
 * goes wrong with no error. The undo of an update and a delete of many rows
 * binds JSON lists too, and must restore the same bytes. A SQLite store
 * runs it from its own test file with a factory that opens a fresh,
 * migrated, empty database.
 */
export function runStoredFormConformance(
  name: string,
  open: () => Promise<StoredFormTarget>,
  options: StoredFormOptions = {},
): void {
  const parents = options.parents ?? [];
  const keepEmail = options.nullEmail === false;
  const models = [
    ...parents,
    ...(Object.keys(schema) as ModelName[]).filter((m) => !parents.includes(m)),
  ];

  /** Each row of each table, a column as its type and `form` of its value, in one sorted text. */
  async function snapshot(t: StoredFormTarget, form: "quote" | "hex"): Promise<string> {
    const tables = (
      await t.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1\\_%' ESCAPE '\\' AND name NOT IN ('ta_migrations', 'ta_meta', 'ta_limit') ORDER BY name",
      )
    ).map((r) => String(r.name));
    const lines: string[] = [];
    for (const table of tables) {
      const cols = (await t.all(`SELECT name FROM pragma_table_info('${table}')`)).map((r) =>
        String(r.name),
      );
      // One pair of terms per column: a text of all columns nests too deep for D1.
      const each = cols.map((c, i) => `typeof("${c}") AS t${i}, ${form}("${c}") AS v${i}`);
      for (const r of await t.all(`SELECT ${each.join(", ")} FROM "${table}"`))
        lines.push(
          `${table}: ${cols.map((c, i) => `${c}=${String(r[`t${i}`])}:${String(r[`v${i}`])}`).join(" | ")}`,
        );
    }
    return lines.sort().join("\n");
  }

  /** Rows 0, 1, and 2 of each model, 2 with nulls, by `create` or by `createMany`. */
  async function writeAll(db: StorageAdapter, many: boolean, prefix = ""): Promise<string[]> {
    const errors: string[] = [];
    for (const m of models) {
      const rows = [0, 1, 2].map((r) => storedRow(m, r, r === 2, prefix, keepEmail));
      try {
        if (many) await db.createMany(m, rows as never[]);
        else for (const row of rows) await db.create(m, row as never);
      } catch (e) {
        errors.push(`${m}: ${(e as Error).message}`);
      }
    }
    return errors;
  }

  describe(`stored form: ${name}`, () => {
    it("stores the same type and value in each column by create and by createMany, and the undo of many rows restores them (ruling 85 of plan 12d)", async () => {
      const one = await open();
      let created: string;
      let refusedOne: string[];
      try {
        refusedOne = await writeAll(one.adapter, false);
        created = await snapshot(one, "quote");
      } finally {
        await one.close();
      }
      const two = await open();
      try {
        expect(await writeAll(two.adapter, true)).toEqual(refusedOne);
        const many = await snapshot(two, "quote");
        expect(many.split("\n").length).toBeGreaterThan(models.length);
        expect(many).toBe(created);
        // An update and a delete of the three rows of each model, in a transaction that
        // throws. The undo of many rows restores each column as it was.
        const errors: string[] = [];
        const written = models.filter((m) => !refusedOne.some((e) => e.startsWith(`${m}: `)));
        for (const m of [...written].reverse()) {
          const fields = schema[m].fields as Record<string, { type: string }>;
          const data: Record<string, unknown> = {};
          for (const [f, def] of Object.entries(fields)) {
            if (f === "id") continue;
            if (def.type === "date") data[f] = new Date(1800000000000);
            else if (def.type === "boolean") data[f] = true;
            else if (def.type === "integer") data[f] = 99;
          }
          const inIds = [
            { field: "id", op: "in", value: [0, 1, 2].map((r) => `id-${m}-${r}`) },
          ] as never[];
          try {
            await two.adapter.transaction(async (tx) => {
              expect(await tx.update(m, inIds, data as never)).toBe(3);
              if (!parents.includes(m)) expect(await tx.delete(m, inIds)).toBe(3);
              throw new Error("boom");
            });
          } catch (e) {
            if ((e as Error).message !== "boom") errors.push(`${m}: ${(e as Error).message}`);
          }
        }
        expect(errors).toEqual([]);
        expect(await snapshot(two, "quote")).toBe(many);
      } finally {
        await two.close();
      }
    });

    it("stores a lone surrogate as U+FFFD by create and by createMany, and reads it back (ruling 85 of plan 12d)", async () => {
      // Each free text starts with a lone high and a lone low surrogate.
      const names = async (db: StorageAdapter) =>
        (await db.findMany("user", [], { sort: { field: "id", dir: "asc" } })).map((u) => u.name);
      const fixed = [0, 1, 2].map(
        (r) => storedRow("user", r, r === 2, "a\ufffdb\ufffd", keepEmail).name,
      );
      const one = await open();
      let created: string;
      try {
        await writeAll(one.adapter, false, "a\ud800b\udc00");
        created = await snapshot(one, "hex");
        expect(await names(one.adapter)).toEqual(fixed);
      } finally {
        await one.close();
      }
      // The bytes of U+FFFD at the start of a text column, and no CESU-8 form of a
      // surrogate (ED A0 80 for U+D800).
      expect(created).toContain("=text:61EFBFBD62EFBFBD");
      expect(created).not.toContain("=text:61EDA080");
      const two = await open();
      try {
        await writeAll(two.adapter, true, "a\ud800b\udc00");
        expect(await snapshot(two, "hex")).toBe(created);
        expect(await names(two.adapter)).toEqual(fixed);
      } finally {
        await two.close();
      }
    });
  });
}
