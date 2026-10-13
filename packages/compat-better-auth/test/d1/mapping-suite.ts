import { env } from "cloudflare:test";
import { type ModelName, schema } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { columnName, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import {
  BETTER_AUTH_TABLES,
  type BetterAuthTable,
  type NamingOptions,
  resolveNames,
  snake,
  TABLE_FIELDS,
} from "../../src/storage/names.js";

export const at = new Date("2026-10-10T00:00:00.000Z");
export const eq = <F extends string>(field: F, value: unknown) => ({
  field,
  op: "eq" as const,
  value,
});

/** The SQL names of one naming, also for the Better Auth columns that core does not read (accessToken). */
export function sqlNames(naming: Omit<NamingOptions, "pgSchema">) {
  const n = resolveNames(naming);
  const T = (t: BetterAuthTable) => n.table(t);
  const C = (t: BetterAuthTable, f: string) =>
    TABLE_FIELDS[t].includes(f) ? n.column(t, f) : `"${naming.casing === "snake" ? snake(f) : f}"`;
  const truncate = async () => {
    await env.DB.batch(
      [
        ...BETTER_AUTH_TABLES.map(T),
        "ta_limit",
        "ta_totp",
        "ta_trusted_device",
        "ta_jwk",
        "ta_oauth_client",
        "ta_oauth_consent",
        "ta_oauth_token",
      ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
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
 * Core's conformance suite and the mapping tests on the D1 database of one
 * test file, with one naming. The file builds the tables and runs the
 * migration first. The raw SQL here takes its names from the naming, so the
 * same tests run on Better Auth's defaults and on snake_case plural tables.
 */
export function d1MappingSuite(label: string, naming: Omit<NamingOptions, "pgSchema">): void {
  const { T, C, truncate } = sqlNames(naming);
  const db = () => betterAuthSchemaStorage({ dialect: "d1", db: env.DB, ...naming }).storage;
  const run = (sql: string) => env.DB.prepare(sql).run();
  const cols = (t: BetterAuthTable, fields: string[]) => fields.map((f) => C(t, f)).join(",");
  // Each child row gets its parent first (plan 9b), so no test seeds a state the product cannot reach.
  const parentUser = (id: string) =>
    db().create("user", {
      id,
      email: `${id}@example.com`,
      emailVerified: false,
      name: null,
      image: null,
      createdAt: at,
      updatedAt: at,
    });

  runAdapterConformance(
    `Better Auth tables on D1, ${label}`,
    async () => {
      await truncate();
      return { adapter: db(), close: truncate };
    },
    { unmapped: ["apiToken"] },
  );

  describe(`the Better Auth mapping on D1, ${label}`, () => {
    beforeEach(truncate);

    it("marks NOT NULL on core's own tables exactly as core's schema does (core's parity check, plans 9f and 9g)", async () => {
      for (const model of [
        "totp",
        "trustedDevice",
        "jwk",
        "oauthClient",
        "oauthConsent",
        "oauthToken",
      ] as const) {
        const info = await env.DB.prepare(`PRAGMA table_info(${TABLES[model]})`).all<{
          name: string;
          notnull: number;
        }>();
        const actual = Object.fromEntries(info.results.map((c) => [c.name, c.notnull]));
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
      ] as const) {
        const list = await env.DB.prepare(`PRAGMA index_list(${TABLES[model]})`).all<{
          name: string;
          unique: number;
          origin: string;
        }>();
        const actual = [];
        for (const ix of list.results.filter((i) => i.origin === "c")) {
          const info = await env.DB.prepare(`PRAGMA index_info(${ix.name})`).all<{
            seqno: number;
            name: string;
          }>();
          const columns = [...info.results].sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
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
        createdAt: at,
        updatedAt: at,
      });
      const raw = await env.DB.prepare(
        `SELECT ${C("user", "createdAt")} AS "createdAt", ${C("user", "emailVerified")} AS "emailVerified", ${C("user", "name")} AS "name" FROM ${T("user")} WHERE ${C("user", "id")} = 'u1'`,
      ).first();
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
        name: null,
        createdAt: at,
        updatedAt: at,
      });
      expect(
        await env.DB.prepare(
          `SELECT ${C("passkey", "publicKey")} AS k FROM ${T("passkey")} WHERE ${C("passkey", "id")} = 'k1'`,
        ).first("k"),
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
      const row = await env.DB.prepare(
        `SELECT ${C("account", "accessToken")} AS "accessToken", ${C("account", "updatedAt")} AS "updatedAt" FROM ${T("account")} WHERE ${C("account", "id")} = 'a1'`,
      ).first();
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
