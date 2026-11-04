import {
  applyPostgresMigrations,
  type CoreFieldType,
  postgresColumnType,
} from "@authtempo/adapter-postgres";
import {
  type Auth,
  createAuth,
  createPbkdf2PasswordHash,
  type ModelName,
  SCHEMA_VERSION,
  type StorageAdapter,
  schema,
} from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { columnName, columnsOf, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import postgres, { type Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "../src/server/better-auth.js";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { type AnyModelMap, issuerFor, MAPPING } from "../src/storage/mapping.js";
import {
  COMPAT_MIGRATION_NAMES,
  compatMigrationSql,
  compatPostgresSteps,
} from "../src/storage/migration.js";
import { resolveNames, TABLE_FIELDS } from "../src/storage/names.js";
import { compatStatements } from "../src/storage/statements.js";
import { BETTER_AUTH_PG, CONSUMER_I_PG } from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock, PG_URL } from "./pg.js";

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

const VECTOR_HASH =
  "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";

/**
 * A store of `tables` with the compat migrations before the one of
 * SCHEMA_VERSION (plan 12h Task 8). An app has such a store before it runs
 * the new file. The cut comes from the runner's own list.
 */
function oldStore(tables: string, naming: { casing?: "snake" } = {}) {
  return async () => {
    const pg = await freshBetterAuthSchema(tables);
    const list = compatPostgresSteps(resolveNames(naming));
    const cut = list.findIndex((m) => m.name.endsWith(`_v${SCHEMA_VERSION}`));
    if (cut < 1) throw new Error(`no compat migration of version ${SCHEMA_VERSION}`);
    for (const m of list.slice(0, cut)) await pg.sql.unsafe(m.text);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, ...naming });
    return { adapter: s.storage, close: () => pg.close() };
  };
}

runAdapterConformance(
  "Better Auth tables on postgres, camelCase (Better Auth's own SQL)",
  async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await migrateWithoutLock(pg.sql, s.names);
    return { adapter: s.storage, close: () => pg.close(), stop: () => pg.stop() };
  },
  // A null address is Better Auth's placeholder in the table since plan 12i Task 16.
  { rowLocks: true, ping: true, oldStore: oldStore(BETTER_AUTH_PG) },
);

runAdapterConformance(
  "Better Auth tables on postgres, snake_case (consumer-i's tables)",
  async () => {
    const pg = await freshBetterAuthSchema(CONSUMER_I_PG);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, casing: "snake" });
    await migrateWithoutLock(pg.sql, s.names);
    return { adapter: s.storage, close: () => pg.close(), stop: () => pg.stop() };
  },
  {
    rowLocks: true,
    ping: true,
    oldStore: oldStore(CONSUMER_I_PG, { casing: "snake" }),
  },
);

/** Rows as Better Auth 1.7 writes them, inserted before the migration, on the fixture with its foreign keys. */
const BETTER_AUTH_ERA = `
INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('ba-u','Bea','bea@example.com',true,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES
  ('ba-cred','local:credential','ba-u','credential','ba-u','${VECTOR_HASH}','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z'),
  ('ba-google','https://accounts.google.com','g-sub','google','ba-u',NULL,'2026-09-03T00:00:00.000Z','2026-09-04T00:00:00.000Z');
INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","ipAddress","userAgent","userId","activeOrganizationId") VALUES ('ba-s','2026-12-01T00:00:00.000Z','ba-raw-token','2026-09-05T00:00:00.000Z','2026-09-06T00:00:00.000Z',NULL,NULL,'ba-u',NULL);
INSERT INTO "verification" ("id","identifier","value","expiresAt","createdAt","updatedAt") VALUES ('ba-v','bea@example.com','ba-value','2026-12-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
INSERT INTO "organization" ("id","name","slug","logo","createdAt","metadata") VALUES ('ba-o','Bea Org','ba-org',NULL,'2026-09-07T00:00:00.000Z','{"plan":"pro"}');
INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES ('ba-m','ba-o','ba-u','owner','2026-09-07T00:00:00.000Z');
INSERT INTO "invitation" ("id","organizationId","email","role","status","expiresAt","createdAt","inviterId") VALUES ('ba-i','ba-o','new@example.com','member','pending','2026-12-01T00:00:00.000Z','2026-09-08T00:00:00.000Z','ba-u');
INSERT INTO "passkey" ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt","aaguid") VALUES ('ba-p','Laptop','+/+/AQ==','ba-u','ba-cred-id',3,'singleDevice',false,'',NULL,NULL);
`;

const at = new Date("2026-10-10T00:00:00.000Z");
const later = new Date("2026-11-10T00:00:00.000Z");
const user = (id: string, email: string) => ({
  id,
  email,
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
const eq = <F extends string>(field: F, value: unknown) => ({ field, op: "eq" as const, value });

describe("the compat runner on postgres (plan 11c)", () => {
  it("reports the names of COMPAT_MIGRATION_NAMES, in order: the CLI and the D1 files read that list", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await pg.sql.unsafe(BETTER_AUTH_ERA);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      expect(await s.migrate()).toEqual([...COMPAT_MIGRATION_NAMES]);
    } finally {
      await pg.close();
    }
  });

  // The beforeEach of the mapping tests ran these two checks until ruling 53
  // of plan 12k moved it to the steps without the lock.
  it("applies 0001 to 0012 on the Better Auth era rows, and a second run applies none", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await pg.sql.unsafe(BETTER_AUTH_ERA);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      expect(await s.migrate()).toEqual([
        "0001_compat_better_auth",
        "0002_compat_schema_v5",
        "0003_compat_schema_v6",
        "0004_compat_schema_v7",
        "0005_compat_schema_v8",
        "0006_compat_schema_v9",
        "0007_compat_schema_v10",
        "0008_compat_schema_v11",
        "0009_compat_schema_v12",
        "0010_compat_schema_v13",
        "0011_compat_schema_v14",
        "0012_compat_schema_v15",
        "0013_compat_schema_v16",
      ]);
      expect(await s.migrate()).toEqual([]);
    } finally {
      await pg.close();
    }
  });

  it("lets two runners start at once on one schema: each migration runs once", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    const other = postgres(PG_URL, {
      max: 1,
      onnotice: () => {},
      connection: {
        search_path: (await pg.sql<{ s: string }[]>`SELECT current_schema() AS s`)[0]?.s ?? "",
      },
    });
    try {
      const results = await Promise.allSettled([
        betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate(),
        betterAuthSchemaStorage({ dialect: "postgres", sql: other }).migrate(),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      // The lock is per migration, so the two runners can share the list.
      const lists = results.map((r) => (r.status === "fulfilled" ? r.value : []));
      expect([...(lists[0] ?? []), ...(lists[1] ?? [])].sort()).toEqual([
        ...COMPAT_MIGRATION_NAMES,
      ]);
    } finally {
      await other.end({ timeout: 5 });
      await pg.close();
    }
  });
});

describe("the Better Auth mapping on postgres", () => {
  let pg: { sql: Sql; close(): Promise<void> };
  let db: StorageAdapter;
  const raw = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    pg.sql.unsafe<T[]>(text, params as never[]);

  beforeEach(async () => {
    pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    await pg.sql.unsafe(BETTER_AUTH_ERA);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await migrateWithoutLock(pg.sql, s.names);
    db = s.storage;
  });
  afterEach(async () => {
    await pg.close();
  });

  it("serves core schema version 16; a new core version needs migration 0014 and a mapping change", () => {
    expect(SCHEMA_VERSION).toBe(16);
  });

  it("names only columns the table field list knows", () => {
    // Every field the extras read, set, so each function answers its full set
    // of columns. The names come from the mapping's own functions, so a wrong
    // column name there fails here.
    const sample: Record<string, unknown> = {
      provider: "google",
      userId: "u1",
      valueHash: "h",
      acceptedAt: new Date(0),
    };
    for (const map of Object.values(MAPPING as unknown as Record<string, AnyModelMap>)) {
      const known = TABLE_FIELDS[map.table];
      const used = [
        ...Object.values(map.fields).map((f) => f.column),
        ...(map.scope ? [map.scope.column] : []),
        ...Object.keys(map.insertExtras?.(sample) ?? {}),
        ...Object.keys(map.updateExtras?.(sample) ?? {}),
      ];
      for (const column of used)
        expect({ table: map.table, column, known: known.includes(column) }).toMatchObject({
          known: true,
        });
    }
  });

  it("stores no name as empty text (Better Auth's NOT NULL) and reads it as null (Review Focus 2)", async () => {
    await db.create("user", user("u1", "a@example.com"));
    expect(
      (await raw<{ name: string }>('SELECT "name" FROM "user" WHERE "id" = $1', ["u1"]))[0]?.name,
    ).toBe("");
    expect((await db.findOne("user", [eq("id", "u1")]))?.name).toBeNull();
    expect((await db.findMany("user", [eq("name", null)])).map((r) => r.id)).toEqual(["u1"]);
    expect((await db.findOne("user", [eq("id", "ba-u")]))?.name).toBe("Bea");
  });

  it("keeps the session token hash in session.token, never a raw token (Review Focus 2)", async () => {
    await db.create("user", user("u1", "a@example.com"));
    const tokenHash = "ab".repeat(32);
    await db.create("session", {
      id: "s1",
      userId: "u1",
      tokenHash,
      expiresAt: later,
      lastSeenAt: at,
      ip: "203.0.113.9",
      userAgent: "ua",
      activeOrganizationId: null,
      freshAt: at,
      actorId: null,
      activeTeamId: null,
      proved: true,
      createdAt: at,
      updatedAt: at,
    });
    const row = (
      await raw<{ token: string; ipAddress: string }>(
        'SELECT "token", "ipAddress" FROM "session" WHERE "id" = $1',
        ["s1"],
      )
    )[0];
    expect(row).toEqual({ token: tokenHash, ipAddress: "203.0.113.9" });
    const found = await db.findOne("session", [eq("tokenHash", tokenHash)]);
    expect(found?.lastSeenAt.getTime()).toBe(at.getTime());
    // A Better Auth-era session holds a raw token, which no core hash matches. It ends at cutover.
    const era = await db.findOne("session", [eq("id", "ba-s")]);
    expect(era?.tokenHash).toBe("ba-raw-token");
    expect(era?.lastSeenAt.toISOString()).toBe("2026-09-06T00:00:00.000Z");
  });

  it("converts the passkey key between base64url in core and standard base64 in the table (Review Focus 2)", async () => {
    await db.create("user", user("u1", "a@example.com"));
    await db.create("passkey", {
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
      (
        await raw<{ publicKey: string }>('SELECT "publicKey" FROM "passkey" WHERE "id" = $1', [
          "k1",
        ])
      )[0]?.publicKey,
    ).toBe("+/+/AQ==");
    expect((await db.findOne("passkey", [eq("id", "k1")]))?.publicKey).toBe("-_-_AQ");
    const era = await db.findOne("passkey", [eq("credentialId", "ba-cred-id")]);
    expect(era).toMatchObject({
      publicKey: "-_-_AQ",
      transports: null,
      counter: 3,
      backedUp: false,
      name: "Laptop",
    });
    expect(era?.createdAt).toBeInstanceOf(Date);
    expect(era?.updatedAt.getTime()).toBe(era?.createdAt.getTime());
  });

  it("keeps the verification fields in the added columns and the hash in value (Review Focus 2)", async () => {
    await db.create("verification", {
      id: "v1",
      purpose: "magic-link",
      identifier: "a@example.com",
      valueHash: "cd".repeat(32),
      expiresAt: later,
      consumedAt: null,
      data: { next: "/home" },
      createdAt: at,
      updatedAt: at,
      secretVersion: 1,
    });
    const row = (
      await raw(
        'SELECT "value", "taPurpose", "taValueHash", "taConsumedAt", "taData" FROM "verification" WHERE "id" = $1',
        ["v1"],
      )
    )[0];
    expect(row).toEqual({
      value: "cd".repeat(32),
      taPurpose: "magic-link",
      taValueHash: "cd".repeat(32),
      taConsumedAt: null,
      taData: '{"next":"/home"}',
    });
    expect(
      await db.update("verification", [eq("valueHash", "cd".repeat(32)), eq("consumedAt", null)], {
        consumedAt: at,
      }),
    ).toBe(1);
    expect((await db.findOne("verification", [eq("id", "v1")]))?.consumedAt?.getTime()).toBe(
      at.getTime(),
    );
  });

  it("never reads a Better Auth-era verification or invitation row", async () => {
    expect((await db.findMany("verification", [])).map((r) => r.id)).toEqual([]);
    expect(
      await db.delete("verification", [
        { field: "expiresAt", op: "lt", value: new Date("2027-01-01T00:00:00.000Z") },
      ]),
    ).toBe(0);
    expect(await db.findMany("invitation", [])).toEqual([]);
    expect((await raw('SELECT "id" FROM "verification"')).length).toBe(1);
    expect((await raw('SELECT "id" FROM "invitation"')).length).toBe(1);
  });

  it("reads a Better Auth credential row as the password row and never as an identity", async () => {
    expect(await db.findOne("password", [eq("userId", "ba-u")])).toMatchObject({
      id: "ba-cred",
      hash: VECTOR_HASH,
    });
    const ids = await db.findMany("identity", [eq("userId", "ba-u")]);
    expect(ids.map((r) => [r.id, r.provider, r.subject])).toEqual([
      ["ba-google", "google", "g-sub"],
    ]);
    expect(ids[0]?.linkedAt.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(
      await db.findOne("identity", [eq("provider", "google"), eq("subject", "g-sub")]),
    ).not.toBeNull();
  });

  it("writes the account columns Better Auth 1.7 reads: issuer, providerId, accountId", async () => {
    await db.create("user", user("u1", "a@example.com"));
    for (const [id, provider, subject] of [
      ["i1", "google", "s1"],
      ["i2", "apple", "s2"],
      ["i3", "email", "a@example.com"],
      ["i4", "github", "42"],
    ] as const) {
      await db.create("identity", {
        id,
        userId: "u1",
        provider,
        subject,
        linkedAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }
    await db.create("password", {
      id: "p1",
      userId: "u1",
      hash: "pbkdf2-sha256$1000$x$y",
      createdAt: at,
      updatedAt: at,
    });
    const rows = await raw<{ id: string; issuer: string; providerId: string; accountId: string }>(
      'SELECT "id", "issuer", "providerId", "accountId" FROM "account" WHERE "userId" = $1 ORDER BY "id"',
      ["u1"],
    );
    expect(rows).toEqual([
      { id: "i1", issuer: "https://accounts.google.com", providerId: "google", accountId: "s1" },
      { id: "i2", issuer: "https://appleid.apple.com", providerId: "apple", accountId: "s2" },
      { id: "i3", issuer: "local:email", providerId: "email", accountId: "a@example.com" },
      { id: "i4", issuer: "local:oauth:github", providerId: "github", accountId: "42" },
      { id: "p1", issuer: "local:credential", providerId: "credential", accountId: "u1" },
    ]);
    await expect(
      db.create("identity", {
        id: "i5",
        userId: "u1",
        provider: "credential",
        subject: "u1",
        linkedAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument", fields: ["provider"] });
    await expect(
      db.create("password", { id: "p2", userId: "u1", hash: "x", createdAt: at, updatedAt: at }),
    ).rejects.toMatchObject({ code: "unique_violation", fields: ["userId"] });
  });

  it("writes the invitation status that Better Auth-era code reads", async () => {
    await db.create("invitation", {
      id: "n1",
      organizationId: "ba-o",
      email: "c@example.com",
      role: "member",
      inviterId: "ba-u",
      tokenHash: "ef".repeat(32),
      expiresAt: later,
      acceptedAt: null,
      teamIds: null,
      createdAt: at,
      updatedAt: at,
    });
    expect(
      (
        await raw<{ status: string }>('SELECT "status" FROM "invitation" WHERE "id" = $1', ["n1"])
      )[0]?.status,
    ).toBe("pending");
    await db.update("invitation", [eq("id", "n1")], { acceptedAt: at, updatedAt: at });
    expect(
      (
        await raw<{ status: string }>('SELECT "status" FROM "invitation" WHERE "id" = $1', ["n1"])
      )[0]?.status,
    ).toBe("accepted");
  });

  it("fills the added columns of Better Auth-era rows from their nearest Better Auth column", async () => {
    expect(await db.findOne("organization", [eq("id", "ba-o")])).toMatchObject({
      slug: "ba-org",
      metadata: { plan: "pro" },
    });
    const org = await db.findOne("organization", [eq("id", "ba-o")]);
    expect(org?.updatedAt.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect((await db.findOne("member", [eq("id", "ba-m")]))?.updatedAt.toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });

  it("answers schema_mismatch on metadata for an organization row that holds text that is not JSON (L-10)", async () => {
    await raw(`UPDATE "organization" SET "metadata" = 'not json' WHERE "id" = 'ba-o'`);
    const err = await db.findOne("organization", [eq("id", "ba-o")]).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "schema_mismatch",
      model: "organization",
      fields: ["metadata"],
    });
  });

  it("reads a member row and an account row that another writer adds after the migration (I-1)", async () => {
    // An old replica during the deploy, or the app's own SQL, writes Better Auth's columns only.
    await raw(`
      INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('ba-u2','Ann','ann@example.com',true,now(),now());
      INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES ('ba-m2','ba-o','ba-u2','member',now());
      INSERT INTO "account" ("id","issuer","accountId","providerId","userId","createdAt","updatedAt") VALUES ('ba-gh','local:oauth:github','42','github','ba-u2',now(),now());
    `);
    expect((await db.findOne("member", [eq("id", "ba-m2")]))?.updatedAt).toBeInstanceOf(Date);
    const identity = await db.findOne("identity", [eq("provider", "github"), eq("subject", "42")]);
    expect(identity?.linkedAt).toBeInstanceOf(Date);
    // The default is cut to milliseconds, the precision core reads back.
    const cut = await raw<{ ok: boolean }>(
      `SELECT bool_and(m."taUpdatedAt" = date_trunc('milliseconds', m."taUpdatedAt") AND a."taLinkedAt" = date_trunc('milliseconds', a."taLinkedAt")) AS ok FROM "member" m, "account" a WHERE m."id" = 'ba-m2' AND a."id" = 'ba-gh'`,
    );
    expect(cut[0]?.ok).toBe(true);
  });
});

/** The unique indexes on account whose columns are exactly issuer and accountId, in either casing, by name. */
async function uniqueIssuerIndexes(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe<{ name: string }[]>(`
    SELECT c.relname AS name FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'account' AND t.relnamespace = current_schema()::regnamespace AND i.indisunique AND i.indnatts = 2
      AND (SELECT array_agg(lower(replace(a.attname, '_', '')) ORDER BY lower(replace(a.attname, '_', ''))) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY (i.indkey)) = ARRAY['accountid', 'issuer']
    ORDER BY 1`);
  return rows.map((r) => r.name);
}

describe("the compat migration on postgres", () => {
  it("refuses every call before the migration with schema_mismatch", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await expect(s.storage.findOne("user", [eq("id", "x")])).rejects.toMatchObject({
        code: "schema_mismatch",
      });
    } finally {
      await pg.close();
    }
  });

  it('sorts the issuer index columns in byte order with COLLATE "C" (L-5)', () => {
    // The musl Postgres image of the tests sorts the same without it, so only the text can fail.
    expect(compatMigrationSql("postgres", resolveNames())).toContain('COLLATE "C"');
  });

  it("refuses a date column without a time zone", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await pg.sql.unsafe('ALTER TABLE "user" ALTER COLUMN "createdAt" TYPE timestamp');
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await expect(s.migrate()).rejects.toThrow(
        /every Better Auth date column must be timestamptz/,
      );
    } finally {
      await pg.close();
    }
  });

  it("adds and fills the issuer column on a table that lacks it (consumer-i)", async () => {
    const pg = await freshBetterAuthSchema(CONSUMER_I_PG);
    try {
      await pg.sql.unsafe(`
        INSERT INTO "user" ("id","name","email") VALUES ('u','U','u@example.com');
        INSERT INTO "account" ("id","account_id","provider_id","user_id","password") VALUES ('a1','u','credential','u','h'), ('a2','g-sub','google','u',NULL);
      `);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, casing: "snake" });
      await migrateWithoutLock(pg.sql, s.names);
      const rows = await pg.sql.unsafe<{ id: string; issuer: string }[]>(
        'SELECT "id", "issuer" FROM "account" ORDER BY "id"',
      );
      expect(rows).toEqual([
        { id: "a1", issuer: "local:credential" },
        { id: "a2", issuer: "https://accounts.google.com" },
      ]);
      expect(await uniqueIssuerIndexes(pg.sql)).toEqual(["ux_account__issuer__account_id"]);
    } finally {
      await pg.close();
    }
  });

  it("makes no second unique index on (issuer, accountId) when Better Auth 1.7's exists", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate();
      expect(await uniqueIssuerIndexes(pg.sql)).toEqual(["account_issuer_accountId_uidx"]);
    } finally {
      await pg.close();
    }
  });

  it("keeps the teams columns of an app that has them, and adds them to an app that has none (plan 12k)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      // Better Auth's teams option adds these two columns. The migration keeps
      // each one and adds no second column. teamMember.teamId is another table (Task 11).
      await pg.sql.unsafe(`ALTER TABLE "session" ADD COLUMN "activeTeamId" text`);
      await pg.sql.unsafe(`ALTER TABLE "invitation" ADD COLUMN "teamId" text`);
      await betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate();
      const cols = await pg.sql.unsafe<{ t: string; c: string }[]>(
        `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('session', 'invitation') AND column_name IN ('activeTeamId', 'teamId') ORDER BY table_name`,
      );
      expect([...cols]).toEqual([
        { t: "invitation", c: "teamId" },
        { t: "session", c: "activeTeamId" },
      ]);
    } finally {
      await pg.close();
    }
    const none = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await betterAuthSchemaStorage({ dialect: "postgres", sql: none.sql }).migrate();
      const cols = await none.sql.unsafe<{ t: string; c: string; n: string }[]>(
        `SELECT table_name AS t, column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('session', 'invitation') AND column_name IN ('activeTeamId', 'teamId') ORDER BY table_name`,
      );
      expect([...cols]).toEqual([
        { t: "invitation", c: "teamId", n: "YES" },
        { t: "session", c: "activeTeamId", n: "YES" },
      ]);
    } finally {
      await none.close();
    }
  });

  it("creates exactly core's ta_ tables (plans 9f, 9g, 12c, 12e, and 12f), and Better Auth's organizationRole, team, and teamMember when they are absent (plan 12k)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const before = await pg.sql.unsafe<{ t: string }[]>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()",
      );
      await betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate();
      const after = await pg.sql.unsafe<{ t: string }[]>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()",
      );
      const added = after
        .map((r) => r.t)
        .filter((t) => !before.some((b) => b.t === t))
        .sort();
      expect(added).toEqual([
        // Better Auth's own table of dynamicAccessControl, which the fixture lacks (migration 0010).
        "organizationRole",
        // Core's own token tables (migration 0010, Task 12).
        "ta_api_token",
        "ta_jwk",
        "ta_limit",
        "ta_meta",
        "ta_moved_token",
        "ta_oauth_client",
        "ta_oauth_consent",
        "ta_oauth_device",
        "ta_oauth_logout",
        "ta_oauth_session_client",
        "ta_oauth_subject",
        "ta_oauth_token",
        "ta_operator_audit",
        "ta_organization_token",
        // Core's own SSO and SCIM tables (migration 0011, plan 12d).
        "ta_scim_group",
        "ta_scim_group_member",
        "ta_scim_token",
        "ta_scim_user",
        "ta_second_factor",
        "ta_sso_connection",
        "ta_sso_domain",
        "ta_totp",
        "ta_trusted_device",
        // Better Auth's own tables of its teams option, which the fixture lacks (migration 0010, Task 11).
        "team",
        "teamMember",
      ]);
      expect(await pg.sql.unsafe("SELECT key, value FROM ta_meta ORDER BY key")).toEqual([
        { key: "compat_better_auth", value: "13" },
        { key: "schema_version", value: "16" },
      ]);
      // Core's columns in core's order (plans 9f and 9g), so core's statements read these tables.
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
        "apiToken",
        "organizationToken",
        "movedToken",
        "ssoConnection",
        "ssoDomain",
        "scimToken",
        "scimUser",
        "scimGroup",
        "scimGroupMember",
      ] as const) {
        const cols = await pg.sql.unsafe<{ c: string }[]>(
          "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
          [TABLES[model]],
        );
        expect({ model, cols: cols.map((r) => r.c) }).toEqual({ model, cols: columnsOf(model) });
      }
    } finally {
      await pg.close();
    }
  });

  it("matches core's schema in NOT NULL and in column type on core's own tables (core's parity check, plans 9f and 9g)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate();
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
        "apiToken",
        "organizationToken",
        "movedToken",
        "ssoConnection",
        "ssoDomain",
        "scimToken",
        "scimUser",
        "scimGroup",
        "scimGroupMember",
      ] as const) {
        const cols = await pg.sql.unsafe<
          { column_name: string; is_nullable: string; data_type: string }[]
        >(
          "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
          [TABLES[model]],
        );
        const actual = Object.fromEntries(
          cols.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable}`]),
        );
        const fields = schema[model].fields as Record<
          string,
          { type: CoreFieldType; nullable?: boolean }
        >;
        const expected = Object.fromEntries(
          Object.entries(fields).map(([f, def]) => [
            columnName(f),
            `${postgresColumnType(f, def.type)} ${def.nullable ? "YES" : "NO"}`,
          ]),
        );
        expect({ model, columns: actual }).toEqual({ model, columns: expected });
      }
    } finally {
      await pg.close();
    }
  });

  it("has core's unique indexes and indexes on core's own tables, with core's names and column order (core's parity check, plan 9g fix round 1)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate();
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
        "apiToken",
        "organizationToken",
        "movedToken",
        "ssoConnection",
        "ssoDomain",
        "scimToken",
        "scimUser",
        "scimGroup",
        "scimGroupMember",
      ] as const) {
        const rows = await pg.sql.unsafe<{ indexname: string; indexdef: string }[]>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname <> $2",
          [TABLES[model], `${TABLES[model]}_pkey`],
        );
        const actual = rows
          .map((r) => ({
            name: r.indexname,
            unique: r.indexdef.includes("CREATE UNIQUE INDEX"),
            columns: (/\(([^)]*)\)$/.exec(r.indexdef)?.[1] ?? r.indexdef).split(", "),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        expect({ model, indexes: actual }).toEqual({ model, indexes: expectedIndexes(model) });
      }
    } finally {
      await pg.close();
    }
  });
});

/**
 * Plan 9 Task 4's rule on the compat statements: the D1 undo of a user
 * created unverified deletes the row only while emailVerified is still false,
 * so an owner's claim inside the open transaction keeps the row. The adapter
 * that runs this undo is D1 (Task 6); the SQL runs here on Better Auth's
 * columns, on the fixture with its foreign keys.
 */
describe("the compat undo of a created user", () => {
  let pg: { sql: Sql; close(): Promise<void> };
  let db: StorageAdapter;
  const st = compatStatements("postgres", resolveNames());
  const undo = async (data: ReturnType<typeof user>) => {
    const s = st.undoCreate("user", data);
    return (await pg.sql.unsafe(s.sql, s.params as never[])).count;
  };
  const ids = async () =>
    (await pg.sql.unsafe<{ id: string }[]>('SELECT "id" FROM "user" ORDER BY "id"')).map(
      (r) => r.id,
    );

  beforeEach(async () => {
    pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await migrateWithoutLock(pg.sql, s.names);
    db = s.storage;
  });
  afterEach(async () => {
    await pg.close();
  });

  it("deletes a user created unverified only while it is still unverified", async () => {
    const left = { ...user("u1", "left@example.com"), emailVerified: false };
    const claimed = { ...user("u2", "claimed@example.com"), emailVerified: false };
    await db.create("user", left);
    await db.create("user", claimed);
    // An owner's reset verifies u2 between the create and the undo.
    expect(await db.update("user", [eq("id", "u2")], { emailVerified: true })).toBe(1);
    expect(await undo(left)).toBe(1);
    expect(await undo(claimed)).toBe(0);
    expect(await ids()).toEqual(["u2"]);
  });

  it("deletes a user created verified by id", async () => {
    const verified = user("u3", "verified@example.com");
    await db.create("user", verified);
    expect(await undo(verified)).toBe(1);
    expect(await ids()).toEqual([]);
  });

  it("names the emailVerified column and the child tables of the naming, in both dialects (plan 8b)", () => {
    const data = { ...user("u4", "x@example.com"), emailVerified: false };
    const snakeNames = resolveNames({ casing: "snake" });
    expect(compatStatements("sqlite", snakeNames).undoCreate("user", data)).toEqual({
      sql:
        'DELETE FROM "user" WHERE "id" = ? AND "email_verified" = ?' +
        ' AND NOT EXISTS (SELECT 1 FROM "account" WHERE "user_id" = ?)' +
        ' AND NOT EXISTS (SELECT 1 FROM "session" WHERE "user_id" = ?)' +
        ' AND NOT EXISTS (SELECT 1 FROM "passkey" WHERE "user_id" = ?)' +
        ' AND NOT EXISTS (SELECT 1 FROM "member" WHERE "user_id" = ?)' +
        // Core's own token table since plan 12k Task 12.
        " AND NOT EXISTS (SELECT 1 FROM ta_api_token WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_totp WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_trusted_device WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_consent WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_token WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_device WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_subject WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_session_client WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_logout WHERE user_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_second_factor WHERE user_id = ?)" +
        // Better Auth's teamMember table keeps its own name, as organizationRole does (plan 12k Task 11).
        ' AND NOT EXISTS (SELECT 1 FROM "teamMember" WHERE "user_id" = ?)' +
        " AND NOT EXISTS (SELECT 1 FROM ta_scim_user WHERE user_id = ?)",
      params: ["u4", 0, ...Array(16).fill("u4")],
    });
    expect(st.undoCreate("user", user("u5", "y@example.com"))).toEqual({
      sql:
        'DELETE FROM "user" WHERE "id" = $1' +
        ' AND NOT EXISTS (SELECT 1 FROM "account" WHERE "userId" = $2)' +
        ' AND NOT EXISTS (SELECT 1 FROM "session" WHERE "userId" = $3)' +
        ' AND NOT EXISTS (SELECT 1 FROM "passkey" WHERE "userId" = $4)' +
        ' AND NOT EXISTS (SELECT 1 FROM "member" WHERE "userId" = $5)' +
        " AND NOT EXISTS (SELECT 1 FROM ta_api_token WHERE user_id = $6)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_totp WHERE user_id = $7)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_trusted_device WHERE user_id = $8)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_consent WHERE user_id = $9)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_token WHERE user_id = $10)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_device WHERE user_id = $11)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_subject WHERE user_id = $12)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_session_client WHERE user_id = $13)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_oauth_logout WHERE user_id = $14)" +
        " AND NOT EXISTS (SELECT 1 FROM ta_second_factor WHERE user_id = $15)" +
        ' AND NOT EXISTS (SELECT 1 FROM "teamMember" WHERE "userId" = $16)' +
        " AND NOT EXISTS (SELECT 1 FROM ta_scim_user WHERE user_id = $17)",
      params: Array(17).fill("u5"),
    });
  });

  it("keeps a verified user that a session names on Better Auth's tables (plan 8b)", async () => {
    const kept = user("u6", "kept@example.com");
    await db.create("user", kept);
    await db.create("session", {
      id: "s6",
      userId: "u6",
      tokenHash: "h-s6",
      expiresAt: later,
      lastSeenAt: at,
      ip: null,
      userAgent: null,
      activeOrganizationId: null,
      freshAt: at,
      actorId: null,
      activeTeamId: null,
      proved: true,
      createdAt: at,
      updatedAt: at,
    });
    expect(await undo(kept)).toBe(0);
    expect(await ids()).toEqual(["u6"]);
  });
});

/**
 * Pre-flight P15: Better Auth's account.userId references user (id), and the
 * password row lives in account. The sign-up writes the user row first (plan 9
 * Task 4). These run on the fixture as recorded, with its seven foreign keys.
 */
describe("the Better Auth foreign keys on postgres", () => {
  let pg: { sql: Sql; close(): Promise<void> };
  let db: StorageAdapter;
  const signUpRows = (order: "user-first" | "password-first") => async (tx: StorageAdapter) => {
    const u = { ...user("u1", "a@example.com"), emailVerified: false };
    const password = {
      id: "p1",
      userId: "u1",
      hash: "pbkdf2-sha256$1000$x$y",
      createdAt: at,
      updatedAt: at,
    };
    if (order === "user-first") await tx.create("user", u);
    await tx.create("password", password);
    if (order === "password-first") await tx.create("user", u);
    await tx.create("identity", {
      id: "i1",
      userId: "u1",
      provider: "email",
      subject: "a@example.com",
      linkedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await tx.create("session", {
      id: "s1",
      userId: "u1",
      tokenHash: "ab".repeat(32),
      expiresAt: later,
      lastSeenAt: at,
      ip: null,
      userAgent: null,
      activeOrganizationId: null,
      freshAt: at,
      actorId: null,
      activeTeamId: null,
      proved: false,
      createdAt: at,
      updatedAt: at,
    });
  };
  const count = async (table: string) =>
    (await pg.sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`))[0]?.n;

  beforeEach(async () => {
    pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await migrateWithoutLock(pg.sql, s.names);
    db = s.storage;
  });
  afterEach(async () => {
    await pg.close();
  });

  it("refuses a password row before its user row, and keeps no row", async () => {
    await expect(db.transaction(signUpRows("password-first"))).rejects.toMatchObject({
      code: "23503",
      constraint_name: "account_userId_fkey",
    });
    expect([await count("user"), await count("account")]).toEqual([0, 0]);
  });
});

describe("the compat migration and core's own write paths on postgres", () => {
  const fast = createPbkdf2PasswordHash({ iterations: 1000 });
  const authOn = (s: ReturnType<typeof betterAuthSchemaStorage>, uniformSignUp = true) =>
    createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: s.storage,
      limiter: s.limiter,
      mail: { send: async () => {} },
      password: { hash: fast, uniformSignUp },
      organizations: {},
    });

  it("runs core's magic link sign-in for a new address on the tables with their foreign keys (L-9)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      const mail: string[] = [];
      const auth = createAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: s.storage,
        limiter: s.limiter,
        mail: { send: async (m) => void mail.push(m.text) },
      });
      expect((await auth.api.requestMagicLink({ email: "link@example.com", ip: null })).ok).toBe(
        true,
      );
      const token = /token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1];
      if (!token) throw new Error("no token in mail");
      const r = await auth.api.verifyMagicLink({
        token: decodeURIComponent(token),
        ip: null,
        userAgent: null,
      });
      expect(r.ok).toBe(true);
      const users = await pg.sql.unsafe<{ id: string }[]>(
        'SELECT "id" FROM "user" WHERE "email" = $1',
        ["link@example.com"],
      );
      expect(users).toHaveLength(1);
      const accounts = await pg.sql.unsafe<{ providerId: string; userId: string }[]>(
        'SELECT "providerId", "userId" FROM "account"',
      );
      expect(accounts).toEqual([{ providerId: "email", userId: users[0]?.id }]);
    } finally {
      await pg.close();
    }
  });

  it("runs core's email sign-up on the tables with their foreign keys (M-2)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      // The detailed answer of plan 8 writes the session row too (plan 12b).
      const pw = authOn(s, false).api.password;
      if (!pw) throw new Error("the password api is missing");
      const r = await pw.signUp({
        email: "new@example.com",
        password: "a long passphrase 1",
        ip: null,
        userAgent: null,
      });
      expect(r.ok).toBe(true);
      const rows = await pg.sql.unsafe<{ providerId: string; password: string | null }[]>(
        'SELECT a."providerId", a."password" FROM "account" a JOIN "user" u ON u."id" = a."userId" WHERE u."email" = $1 ORDER BY a."providerId"',
        ["new@example.com"],
      );
      // The pending$ row was activated by core's conditional update on account.password.
      expect(rows.map((x) => x.providerId)).toContain("credential");
      const credential = rows.find((x) => x.providerId === "credential");
      expect(credential?.password).toMatch(/^pbkdf2-sha256\$1000\$/);
      expect((await pg.sql.unsafe('SELECT "id" FROM "session"')).length).toBe(1);
      // The uniform answer (the default) writes the user and the password, and no session.
      const uniform = await authOn(s).api.password?.signUp({
        email: "other@example.com",
        password: "a long passphrase 1",
        ip: null,
        userAgent: null,
      });
      expect(uniform).toEqual({ ok: true, value: { sent: true } });
      const other = await pg.sql.unsafe<{ password: string | null }[]>(
        'SELECT a."password" FROM "account" a JOIN "user" u ON u."id" = a."userId" WHERE u."email" = $1 AND a."providerId" = $2',
        ["other@example.com", "credential"],
      );
      expect(other[0]?.password).toMatch(/^pbkdf2-sha256\$1000\$/);
      expect((await pg.sql.unsafe('SELECT "id" FROM "session"')).length).toBe(1);
    } finally {
      await pg.close();
    }
  });

  it("lets an owner write on a Better Auth-era organization whose createdAt has microseconds (I-2)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await pg.sql.unsafe(`
        INSERT INTO "user" ("id","name","email","emailVerified") VALUES ('o1','One','one@example.com',true), ('o2','Two','two@example.com',true);
        INSERT INTO "organization" ("id","name","slug","createdAt") VALUES ('org','Org','org','2026-09-07T10:11:12.345678Z');
        INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES ('m1','org','o1','owner','2026-09-07T10:11:12.345678Z'), ('m2','org','o2','owner','2026-09-07T10:11:12.345678Z');
      `);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      const caller = await s.storage.findOne("user", [eq("id", "o1")]);
      if (!caller) throw new Error("the caller is missing");
      // Demoting an owner runs ownerWrite: update organization where updatedAt = the read value.
      const r = await authOn(s).api.updateMemberRole({
        user: caller,
        organizationId: "org",
        userId: "o2",
        role: "member",
      });
      expect(r).toMatchObject({ ok: true });
    } finally {
      await pg.close();
    }
  });

  it("fills the issuer of every provider core knows with the value issuerFor writes (M-1)", async () => {
    const pg = await freshBetterAuthSchema(CONSUMER_I_PG);
    const providers = ["credential", "email", "google", "apple", "github"];
    try {
      await pg.sql.unsafe(
        `INSERT INTO "user" ("id","name","email") VALUES ('u','U','u@example.com');`,
      );
      for (const p of providers) {
        await pg.sql.unsafe(
          'INSERT INTO "account" ("id","account_id","provider_id","user_id") VALUES ($1, $2, $3, $4)',
          [`a-${p}`, `sub-${p}`, p, "u"],
        );
      }
      await betterAuthSchemaStorage({
        dialect: "postgres",
        sql: pg.sql,
        casing: "snake",
      }).migrate();
      const rows = await pg.sql.unsafe<{ provider_id: string; issuer: string }[]>(
        'SELECT "provider_id", "issuer" FROM "account" ORDER BY "id"',
      );
      expect(Object.fromEntries(rows.map((r) => [r.provider_id, r.issuer]))).toEqual(
        Object.fromEntries(providers.map((p) => [p, issuerFor(p)])),
      );
    } finally {
      await pg.close();
    }
  });

  it("finds Better Auth's unique index on a capitalized column name in byte order (M-3)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      // Under an ICU or a glibc en_US collation "accountId" sorts before "Issuer"; in byte order
      // (COLLATE "C", JavaScript sort()), after. The test server runs on musl, whose en_US.utf8
      // sorts in byte order, so the break proof uses COLLATE "en-x-icu".
      await pg.sql.unsafe('ALTER TABLE "account" RENAME COLUMN "issuer" TO "Issuer"');
      await betterAuthSchemaStorage({
        dialect: "postgres",
        sql: pg.sql,
        columns: { account: { issuer: "Issuer" } },
      }).migrate();
      expect(await uniqueIssuerIndexes(pg.sql)).toEqual(["account_issuer_accountId_uidx"]);
    } finally {
      await pg.close();
    }
  });

  it("makes its own unique index when the existing one is not valid (M-3)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await pg.sql.unsafe(`
        DROP INDEX "account_issuer_accountId_uidx";
        INSERT INTO "user" ("id","name","email","emailVerified") VALUES ('u','U','u@example.com',true);
        INSERT INTO "account" ("id","issuer","accountId","providerId","userId","updatedAt") VALUES ('a1','i','s','google','u',now()), ('a2','i','s','google','u',now());
      `);
      // A concurrent build that fails on the duplicate leaves an index with indisvalid false.
      await expect(
        pg.sql.unsafe(
          'CREATE UNIQUE INDEX CONCURRENTLY "broken_uidx" ON "account" ("issuer", "accountId")',
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await pg.sql.unsafe(`DELETE FROM "account" WHERE "id" = 'a2'`);
      await betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate();
      expect(await uniqueIssuerIndexes(pg.sql)).toEqual([
        "broken_uidx",
        "ux_account__issuer__account_id",
      ]);
    } finally {
      await pg.close();
    }
  });

  it("stops at migrate() on a schema that holds core's own ta_meta and ta_limit, and changes nothing (README)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await applyPostgresMigrations(pg.sql);
      await expect(
        betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).migrate(),
      ).rejects.toThrow('relation "ta_limit" already exists');
      const added = await pg.sql.unsafe(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'account' AND column_name = 'taLinkedAt'",
      );
      expect(added.length).toBe(0);
    } finally {
      await pg.close();
    }
  });
});

describe("Better Auth-era GitHub and LinkedIn accounts on postgres (plan 9c)", () => {
  // Better Auth 1.7.2 stores accountId = profile.id for github and profile.sub for linkedin
  // (social-providers/github.ts and linkedin.ts at tag v1.7.2, read 2026-10-12), with the
  // issuer `local:oauth:<id>`. The providers answer other addresses below, so only the
  // subject can link these rows.
  const BA_ROWS = `
INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES
  ('ba-gh-u','Gil','gil@example.com',true,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
  ('ba-li-u','Lia','lia@example.com',true,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
INSERT INTO "account" ("id","issuer","accountId","providerId","userId","createdAt","updatedAt") VALUES
  ('ba-gh','local:oauth:github','583231','github','ba-gh-u','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z'),
  ('ba-li','local:oauth:linkedin','782bbtaQ','linkedin','ba-li-u','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z');
`;
  const PROVIDER_ROUTES = {
    "https://github.com/login/oauth/access_token": {
      access_token: "gho_compat",
      token_type: "bearer",
      scope: "read:user,user:email",
    },
    "https://api.github.com/user": {
      login: "gil",
      id: 583231,
      name: "Gil",
      email: null,
      avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
    "https://api.github.com/user/emails": [
      { email: "gil@new.example", primary: true, verified: true, visibility: "private" },
    ],
    "https://www.linkedin.com/oauth/v2/accessToken": {
      access_token: "li-at",
      id_token: "li-idtok",
      token_type: "Bearer",
      expires_in: 3600,
    },
    // The preset reads the subject here, not from the ID token above.
    "https://api.linkedin.com/v2/userinfo": {
      sub: "782bbtaQ",
      name: "Lia L",
      email: "lia@other.example",
      email_verified: true,
    },
  };
  const fetchFor =
    (routes: Record<string, unknown>): typeof fetch =>
    async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Object.hasOwn(routes, url)
        ? Response.json(routes[url])
        : new Response("not found", { status: 404 });
    };
  async function signIn(auth: Auth, provider: string) {
    const started = await auth.api.startSocial({ provider, ip: null });
    if (!started.ok) throw new Error(`start failed: ${started.code}`);
    const url = new URL(started.value.location);
    return auth.api.completeSocial({
      provider,
      state: url.searchParams.get("state"),
      code: "c1",
      error: null,
      bindToken: started.value.bindToken,
      ip: null,
      userAgent: null,
    });
  }

  it("links each row on the first sign-in by its subject, with no second user or account (Review Focus 5)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    try {
      await pg.sql.unsafe(BA_ROWS);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      const auth = createAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: s.storage,
        limiter: s.limiter,
        mail: { send: async () => {} },
        social: {
          github: { clientId: "gh-id", clientSecret: "gh-secret" },
          linkedin: { clientId: "li-id", clientSecret: "li-secret" },
          fetch: fetchFor(PROVIDER_ROUTES),
        },
      });
      const gh = await signIn(auth, "github");
      expect(gh.ok && gh.value.user.id).toBe("ba-gh-u");
      const li = await signIn(auth, "linkedin");
      expect(li.ok && li.value.user.id).toBe("ba-li-u");
      const users = await pg.sql.unsafe<{ id: string }[]>('SELECT "id" FROM "user" ORDER BY "id"');
      expect(users.map((u) => u.id)).toEqual(["ba-gh-u", "ba-li-u"]);
      const accounts = await pg.sql.unsafe<{ id: string }[]>(
        `SELECT "id" FROM "account" WHERE "providerId" IN ('github', 'linkedin') ORDER BY "id"`,
      );
      expect(accounts.map((a) => a.id)).toEqual(["ba-gh", "ba-li"]);
    } finally {
      await pg.close();
    }
  });

  it("links each row through betterAuth() and its handler, with no second user or account (Review Focus 5)", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    // Core binds globalThis.fetch when it builds the config: stub it first.
    vi.stubGlobal("fetch", fetchFor(PROVIDER_ROUTES));
    try {
      await pg.sql.unsafe(BA_ROWS);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      const auth = betterAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        database: s,
        socialProviders: {
          github: { clientId: "gh-id", clientSecret: "gh-secret" },
          linkedin: { clientId: "li-id", clientSecret: "li-secret" },
        },
      });
      for (const provider of ["github", "linkedin"]) {
        const start = await auth.handler(
          new Request(`https://api.example.com/api/auth/social/${provider}/start`),
        );
        expect(start.status).toBe(302);
        const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
        const bind = (
          start.headers.getSetCookie().find((c) => c.startsWith("__Secure-tempo_session_oauth=")) ??
          ""
        ).split(";")[0] as string;
        expect(bind).not.toBe("");
        const done = await auth.handler(
          new Request(
            `https://api.example.com/api/auth/social/${provider}/callback?code=c1&state=${state}`,
            { headers: { cookie: bind } },
          ),
        );
        expect(
          done.headers
            .getSetCookie()
            .some(
              (c) =>
                c.startsWith("__Host-tempo_session=") && !c.startsWith("__Host-tempo_session=;"),
            ),
        ).toBe(true);
      }
      const sessions = await pg.sql.unsafe<{ userId: string }[]>(
        'SELECT "userId" FROM "session" ORDER BY "userId"',
      );
      expect(sessions.map((r) => r.userId)).toEqual(["ba-gh-u", "ba-li-u"]);
      const users = await pg.sql.unsafe<{ id: string }[]>('SELECT "id" FROM "user" ORDER BY "id"');
      expect(users.map((u) => u.id)).toEqual(["ba-gh-u", "ba-li-u"]);
      const accounts = await pg.sql.unsafe<{ id: string }[]>(
        `SELECT "id" FROM "account" WHERE "providerId" IN ('github', 'linkedin') ORDER BY "id"`,
      );
      expect(accounts.map((a) => a.id)).toEqual(["ba-gh", "ba-li"]);
    } finally {
      vi.unstubAllGlobals();
      await pg.close();
    }
  });
});

describe("Better Auth-era TikTok and WeChat accounts on postgres (plan 12i Task 22)", () => {
  // Better Auth 1.7.2 keeps accountId = profile.data.user.open_id for tiktok and
  // profile.unionid || profile.openid for wechat, and a placeholder address
  // `<id>@<provider>.placeholder.invalid` that it never verifies
  // (social-providers/tiktok.ts, wechat.ts, utils/email.ts, read 2026-10-24).
  const BA_ROWS = `
INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES
  ('ba-tt-u','Tia','-000tt@tiktok.placeholder.invalid',false,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
  ('ba-wx-u','Wen','owxunion@wechat.placeholder.invalid',false,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
INSERT INTO "account" ("id","issuer","accountId","providerId","userId","createdAt","updatedAt") VALUES
  ('ba-tt','local:oauth:tiktok','-000tt','tiktok','ba-tt-u','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z'),
  ('ba-wx','local:oauth:wechat','owxunion','wechat','ba-wx-u','2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z');
`;
  // Each answer by its URL with no query: the WeChat calls carry their values in the query.
  const PROVIDER_ROUTES: Record<string, unknown> = {
    "https://open.tiktokapis.com/v2/oauth/token/": {
      access_token: "act.compat",
      open_id: "-000tt",
      token_type: "Bearer",
    },
    "https://open.tiktokapis.com/v2/user/info/": {
      data: { user: { open_id: "-000tt", display_name: "Tia T" } },
      error: { code: "ok", message: "", log_id: "1" },
    },
    "https://api.weixin.qq.com/sns/oauth2/access_token": {
      access_token: "wx-compat",
      openid: "owxopen",
      unionid: "owxunion",
      scope: "snsapi_login",
    },
    "https://api.weixin.qq.com/sns/userinfo": {
      openid: "owxopen",
      unionid: "owxunion",
      nickname: "Wen W",
    },
  };
  const fetchByPath: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0] ?? "";
    return Object.hasOwn(PROVIDER_ROUTES, path)
      ? Response.json(PROVIDER_ROUTES[path])
      : new Response("not found", { status: 404 });
  };

  it("links each row through betterAuth() and its handler, with no second user or account", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    // Core binds globalThis.fetch when it builds the config: stub it first.
    vi.stubGlobal("fetch", fetchByPath);
    try {
      await pg.sql.unsafe(BA_ROWS);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, s.names);
      const auth = betterAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        database: s,
        socialProviders: {
          tiktok: { clientKey: "tt-key", clientSecret: "tt-secret" },
          wechat: { clientId: "wx-app", clientSecret: "wx-secret" },
        },
      });
      for (const provider of ["tiktok", "wechat"]) {
        const start = await auth.handler(
          new Request(`https://api.example.com/api/auth/social/${provider}/start`),
        );
        expect(start.status).toBe(302);
        const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
        const bind = (
          start.headers.getSetCookie().find((c) => c.startsWith("__Secure-tempo_session_oauth=")) ??
          ""
        ).split(";")[0] as string;
        expect(bind).not.toBe("");
        const done = await auth.handler(
          new Request(
            `https://api.example.com/api/auth/social/${provider}/callback?code=c1&state=${state}`,
            { headers: { cookie: bind } },
          ),
        );
        expect(
          done.headers
            .getSetCookie()
            .some(
              (c) =>
                c.startsWith("__Host-tempo_session=") && !c.startsWith("__Host-tempo_session=;"),
            ),
          provider,
        ).toBe(true);
      }
      const sessions = await pg.sql.unsafe<{ userId: string }[]>(
        'SELECT "userId" FROM "session" ORDER BY "userId"',
      );
      expect(sessions.map((r) => r.userId)).toEqual(["ba-tt-u", "ba-wx-u"]);
      const users = await pg.sql.unsafe<{ id: string }[]>('SELECT "id" FROM "user" ORDER BY "id"');
      expect(users.map((u) => u.id)).toEqual(["ba-tt-u", "ba-wx-u"]);
      const accounts = await pg.sql.unsafe<{ id: string }[]>(
        `SELECT "id" FROM "account" WHERE "providerId" IN ('tiktok', 'wechat') ORDER BY "id"`,
      );
      expect(accounts.map((a) => a.id)).toEqual(["ba-tt", "ba-wx"]);
    } finally {
      vi.unstubAllGlobals();
      await pg.close();
    }
  });
});
