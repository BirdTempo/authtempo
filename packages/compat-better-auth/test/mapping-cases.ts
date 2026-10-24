import type { D1Subset } from "@authtempo/adapter-d1/seam";
import { type ModelName, type StorageAdapter, schema } from "@authtempo/core";
import {
  type ConformanceOptions,
  runAdapterConformance,
  runStoredFormConformance,
} from "@authtempo/core/conformance";
import { columnName, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type BetterAuthTable,
  MAPPED_TABLES,
  type NamingOptions,
  resolveNames,
  snake,
  TABLE_FIELDS,
} from "../src/storage/names.js";

export const at = new Date("2026-10-10T00:00:00.000Z");
export const eq = <F extends string>(field: F, value: unknown) => ({
  field,
  op: "eq" as const,
  value,
});

/** The SQL names of one naming, also for the Better Auth columns that core does not read (accessToken). */
export function sqlNames(naming: Omit<NamingOptions, "pgSchema">, rawDb: D1Subset) {
  const n = resolveNames(naming);
  const T = (t: BetterAuthTable) => n.table(t);
  const C = (t: BetterAuthTable, f: string) =>
    TABLE_FIELDS[t].includes(f) ? n.column(t, f) : `"${naming.casing === "snake" ? snake(f) : f}"`;
  const truncate = async () => {
    await rawDb.batch(
      [
        ...MAPPED_TABLES.map(T),
        "ta_limit",
        "ta_totp",
        "ta_trusted_device",
        "ta_jwk",
        "ta_oauth_client",
        "ta_oauth_consent",
        "ta_oauth_token",
        "ta_second_factor",
        "ta_oauth_device",
        "ta_oauth_subject",
        "ta_oauth_session_client",
        "ta_oauth_logout",
        "ta_operator_audit",
        "ta_api_token",
        "ta_organization_token",
        "ta_moved_token",
        "ta_sso_connection",
        "ta_sso_domain",
        "ta_scim_token",
        "ta_scim_user",
        "ta_scim_group",
        "ta_scim_group_member",
      ].map((t) => rawDb.prepare(`DELETE FROM ${t}`)),
    );
  };
  return { n, T, C, truncate };
}

/** Core's unique indexes and indexes of one model, with core's names and column order. */
function expectedIndexes(model: ModelName) {
  const cols = (fields: readonly string[]) => fields.map(columnName);
  return [
    ...schema[model].unique.map((f) => ({
      name: uniqueIndexName(model, f),
      unique: true,
      columns: cols(f),
    })),
    ...schema[model].indexes.map((f) => ({
      name: `ix_${TABLES[model]}__${cols(f).join("__")}`,
      unique: false,
      columns: cols(f),
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Core's conformance suite and the mapping tests on one SQLite database
 * (plan 12g): a D1 binding, or the seam of a SQLite driver. The caller
 * builds the tables and runs the migration first. The raw SQL here takes its
 * names from the naming, so the same tests run on Better Auth's defaults and
 * on snake_case plural tables. `runs` names the two describe blocks.
 * `conformance` adds options of the core suite, such as the ping row.
 */
export function mappingCases(
  runs: { conformance: string; mapping: string },
  naming: Omit<NamingOptions, "pgSchema">,
  rawDb: D1Subset,
  storage: () => StorageAdapter,
  conformance: ConformanceOptions = {},
): void {
  const { T, C, truncate } = sqlNames(naming, rawDb);
  const db = storage;
  const run = (sql: string) => rawDb.prepare(sql).run();
  /** The rows of one raw query, typed by the caller. */
  const rows = async <R>(sql: string) => (await rawDb.prepare(sql).all()).results as R[];
  const cols = (t: BetterAuthTable, fields: string[]) => fields.map((f) => C(t, f)).join(",");
  // Each child row gets its parent first (plan 9b), so no test seeds a state the product cannot reach.
  const parentUser = (id: string) =>
    db().create("user", {
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
      createdAt: at,
      updatedAt: at,
    });

  runAdapterConformance(
    runs.conformance,
    async () => {
      await truncate();
      return { adapter: db(), close: truncate };
    },
    // D1 sends an update in a transaction as 2 statements: the read for the undo and the write.
    // The D1 suite adds the ping row of plan 12h through `conformance`. Better Auth's
    // user.email is NOT NULL until Task 16 of plan 12i maps a null address.
    { updateInTransaction: 2, nullEmail: false, ...conformance },
  );

  // The foreign keys of Better Auth name the user, the organization, and the team rows.
  runStoredFormConformance(
    runs.conformance,
    async () => {
      await truncate();
      return {
        adapter: db(),
        all: async (sql) => (await rawDb.prepare(sql).all()).results,
        close: truncate,
      };
    },
    // Better Auth's user.email is NOT NULL until Task 16 of plan 12i maps a null address.
    { parents: ["user", "organization", "team"], nullEmail: false },
  );

  describe(runs.mapping, () => {
    beforeEach(truncate);

    it("marks NOT NULL on core's own tables exactly as core's schema does (core's parity check, plans 9f and 9g)", async () => {
      for (const model of [
        "totp",
        "trustedDevice",
        "jwk",
        "oauthClient",
        "oauthConsent",
        "oauthToken",
        "secondFactor",
        "oauthDevice",
        "oauthSubject",
        "oauthSessionClient",
        "oauthLogout",
        "operatorAudit",
        "ssoConnection",
        "ssoDomain",
        "scimToken",
        "scimUser",
        "scimGroup",
        "scimGroupMember",
      ] as const) {
        const info = await rows<{ name: string; notnull: number }>(
          `PRAGMA table_info(${TABLES[model]})`,
        );
        const actual = Object.fromEntries(info.map((c) => [c.name, c.notnull]));
        const fields = schema[model].fields as Record<string, { nullable?: boolean }>;
        const expected = Object.fromEntries(
          Object.entries(fields).map(([f, def]) => [columnName(f), def.nullable ? 0 : 1]),
        );
        expect({ model, notnull: actual }).toEqual({ model, notnull: expected });
      }
    });

    it("has core's unique indexes and indexes on core's own tables, with core's names and column order (core's parity check, plan 9g fix round 1)", async () => {
      for (const model of [
        "totp",
        "trustedDevice",
        "jwk",
        "oauthClient",
        "oauthConsent",
        "oauthToken",
        "secondFactor",
        "oauthDevice",
        "oauthSubject",
        "oauthSessionClient",
        "oauthLogout",
        "operatorAudit",
        "ssoConnection",
        "ssoDomain",
        "scimToken",
        "scimUser",
        "scimGroup",
        "scimGroupMember",
      ] as const) {
        const list = await rows<{ name: string; unique: number; origin: string }>(
          `PRAGMA index_list(${TABLES[model]})`,
        );
        const actual = [];
        for (const ix of list.filter((i) => i.origin === "c")) {
          const info = await rows<{ seqno: number; name: string }>(`PRAGMA index_info(${ix.name})`);
          const columns = [...info].sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
          actual.push({ name: ix.name, unique: ix.unique === 1, columns });
        }
        actual.sort((a, b) => a.name.localeCompare(b.name));
        expect({ model, indexes: actual }).toEqual({ model, indexes: expectedIndexes(model) });
      }
    });

    it("keeps a user row that another request verified inside the open transaction (Task 4's undo on Better Auth's columns)", async () => {
      const s = db();
      await expect(
        s.transaction(async (tx) => {
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
          // Another request, outside this transaction: an owner's claim verifies the row.
          await s.update("user", [eq("id", "u1")], { emailVerified: true });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await s.findOne("user", [eq("id", "u1")]))?.emailVerified).toBe(true);
    });

    it("keeps a later write of another request over a hold that wrote the same value (ruling 46 of plan 12k)", async () => {
      const s = db();
      await s.create("user", {
        id: "u1",
        email: "a@example.com",
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
      const later = new Date("2026-10-10T00:00:00.001Z");
      await expect(
        s.transaction(async (tx) => {
          // The user hold: updatedAt back to its own value.
          await tx.update("user", [eq("id", "u1")], { updatedAt: at });
          // Another request, outside this transaction: a profile write in a before hook.
          await s.update("user", [eq("id", "u1")], { name: "Ada", updatedAt: later });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await s.findOne("user", [eq("id", "u1")])).toMatchObject({
        name: "Ada",
        updatedAt: new Date("2026-10-10T00:00:00.001Z"),
      });
    });

    it("restores each column on its own and keeps a column that another request moved (ruling 47 of plan 12k)", async () => {
      const s = db();
      await s.create("user", {
        id: "u1",
        email: "a@example.com",
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
      await expect(
        s.transaction(async (tx) => {
          await tx.update("user", [eq("id", "u1")], {
            name: "X",
            updatedAt: new Date("2026-10-10T00:00:00.001Z"),
          });
          // Another request, outside this transaction: a profile write of the image.
          await s.update("user", [eq("id", "u1")], {
            image: "https://i.example.com/a.png",
            updatedAt: new Date("2026-10-10T00:00:00.002Z"),
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await s.findOne("user", [eq("id", "u1")])).toMatchObject({
        name: null,
        image: "https://i.example.com/a.png",
        updatedAt: new Date("2026-10-10T00:00:00.002Z"),
      });
    });

    it("keeps a user created verified when another request adds a session inside the open transaction (plan 8b)", async () => {
      const s = db();
      await expect(
        s.transaction(async (tx) => {
          await tx.create("user", {
            id: "u1",
            email: "a@example.com",
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
          // Another request, outside this transaction: a sign-in of that user.
          await s.create("session", {
            id: "s1",
            userId: "u1",
            tokenHash: "h-s1",
            expiresAt: new Date(at.getTime() + 86_400_000),
            lastSeenAt: at,
            ip: null,
            userAgent: null,
            activeOrganizationId: null,
            freshAt: at,
            actorId: null,
            activeTeamId: null,
            createdAt: at,
            updatedAt: at,
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await s.findOne("user", [eq("id", "u1")])).not.toBeNull();
      expect(await s.findOne("session", [eq("id", "s1")])).not.toBeNull();
    });

    it("keeps a user created verified when another request links an identity inside the open transaction, the account table (plan 8b)", async () => {
      const s = db();
      await expect(
        s.transaction(async (tx) => {
          await tx.create("user", {
            id: "u1",
            email: "a@example.com",
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
          // Another request, outside this transaction: a social claim of that user.
          await s.create("identity", {
            id: "i1",
            userId: "u1",
            provider: "google",
            subject: "g-1",
            linkedAt: at,
            createdAt: at,
            updatedAt: at,
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await s.findOne("user", [eq("id", "u1")])).not.toBeNull();
      expect(await s.findOne("identity", [eq("id", "i1")])).not.toBeNull();
    });

    it("stores dates as ISO text and booleans as 1, so Better Auth-era rows compare in order", async () => {
      await run(
        `INSERT INTO ${T("user")} (${cols("user", ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"])}) VALUES ('ba-u','Bea','bea@example.com',1,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
      );
      await db().create("user", {
        id: "u1",
        email: "a@example.com",
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
      const raw = await rawDb
        .prepare(
          `SELECT ${C("user", "createdAt")} AS "createdAt", ${C("user", "emailVerified")} AS "emailVerified", ${C("user", "name")} AS "name" FROM ${T("user")} WHERE ${C("user", "id")} = 'u1'`,
        )
        .first();
      expect(raw).toEqual({ createdAt: "2026-10-10T00:00:00.000Z", emailVerified: 1, name: "" });
      const older = await db().findMany("user", [
        { field: "createdAt", op: "lt", value: new Date("2026-10-01T00:00:00.000Z") },
      ]);
      expect(older.map((r) => r.id)).toEqual(["ba-u"]);
      expect(older[0]?.emailVerified).toBe(true);
    });

    it("converts the passkey key and reads Better Auth's empty transports as null", async () => {
      const s = db();
      await parentUser("u1");
      await s.create("passkey", {
        id: "k1",
        userId: "u1",
        credentialId: "c1",
        publicKey: "-_-_AQ",
        counter: 0,
        transports: null,
        deviceType: "multiDevice",
        backedUp: true,
        discoverable: null,
        prf: false,
        largeBlob: false,
        name: null,
        createdAt: at,
        updatedAt: at,
      });
      expect(
        await rawDb
          .prepare(
            `SELECT ${C("passkey", "publicKey")} AS k FROM ${T("passkey")} WHERE ${C("passkey", "id")} = 'k1'`,
          )
          .first("k"),
      ).toBe("+/+/AQ==");
      await run(
        `INSERT INTO ${T("passkey")} (${cols("passkey", ["id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "transports", "createdAt", "aaguid", "taUpdatedAt"])}) VALUES ('ba-p','Laptop','+/+/AQ==','u1','ba-cred-id',3,'singleDevice',0,'','2026-09-01T00:00:00.000Z',NULL,'2026-09-01T00:00:00.000Z')`,
      );
      expect(await s.findOne("passkey", [eq("credentialId", "ba-cred-id")])).toMatchObject({
        publicKey: "-_-_AQ",
        transports: null,
        backedUp: false,
      });
    });

    it("reverses a delete inside a transaction with every Better Auth column, also the ones core does not know", async () => {
      await parentUser("u1");
      await run(
        `INSERT INTO ${T("account")} (${cols("account", ["id", "issuer", "accountId", "providerId", "userId", "accessToken", "createdAt", "updatedAt", "taLinkedAt"])}) VALUES ('a1','https://accounts.google.com','g-sub','google','u1','at-1','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
      );
      const s = db();
      await expect(
        s.transaction(async (tx) => {
          await tx.update("identity", [eq("id", "a1")], { updatedAt: at });
          await tx.delete("identity", [eq("id", "a1")]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const row = await rawDb
        .prepare(
          `SELECT ${C("account", "accessToken")} AS "accessToken", ${C("account", "updatedAt")} AS "updatedAt" FROM ${T("account")} WHERE ${C("account", "id")} = 'a1'`,
        )
        .first();
      expect(row).toEqual({ accessToken: "at-1", updatedAt: "2026-09-01T00:00:00.000Z" });
    });

    it("reads a member row and an account row that another writer adds after the migration, also in SQLite's date form", async () => {
      // An old replica during the deploy, or the app's own SQL, writes Better Auth's columns only.
      // SQLite's ADD COLUMN takes no expression default, so the ta dates stay null here.
      await parentUser("ba-u2");
      await db().create("organization", {
        id: "ba-o",
        slug: "ba-o",
        name: "BA O",
        metadata: null,
        createdAt: at,
        updatedAt: at,
      });
      await run(
        `INSERT INTO ${T("member")} (${cols("member", ["id", "organizationId", "userId", "role", "createdAt"])}) VALUES ('ba-m2','ba-o','ba-u2','member','2026-09-07 10:11:12')`,
      );
      await run(
        `INSERT INTO ${T("account")} (${cols("account", ["id", "issuer", "accountId", "providerId", "userId", "createdAt", "updatedAt"])}) VALUES ('ba-gh','local:oauth:github','42','github','ba-u2','2026-09-08T01:02:03.456Z','2026-09-08T01:02:03.456Z')`,
      );
      const s = db();
      const member = await s.findOne("member", [eq("id", "ba-m2")]);
      expect(member?.updatedAt.toISOString()).toBe("2026-09-07T10:11:12.000Z");
      const identity = await s.findOne("identity", [eq("provider", "github"), eq("subject", "42")]);
      expect(identity?.linkedAt.toISOString()).toBe("2026-09-08T01:02:03.456Z");
      // A guard compares the value it read with eq (ownerWrite): the where reads the same value.
      expect(
        await s.update("member", [eq("id", "ba-m2"), eq("updatedAt", member?.updatedAt)], {
          role: "admin",
        }),
      ).toBe(1);
    });
  });
}
