import { SCHEMA_VERSION, type StorageAdapter } from "@tempo-auth/core";
import { runAdapterConformance } from "@tempo-auth/core/conformance";
import type { Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { type AnyModelMap, MAPPING } from "../src/storage/mapping.js";
import { resolveNames, TABLE_FIELDS } from "../src/storage/names.js";
import { compatStatements } from "../src/storage/statements.js";
import { BETTER_AUTH_PG, CONSUMER_I_PG, withoutForeignKeys } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

const VECTOR_HASH =
  "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";

runAdapterConformance(
  "Better Auth tables on postgres, camelCase (Better Auth's own SQL)",
  async () => {
    const pg = await freshBetterAuthSchema(withoutForeignKeys(BETTER_AUTH_PG));
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await s.migrate();
    return { adapter: s.storage, close: () => pg.close() };
  },
);

runAdapterConformance(
  "Better Auth tables on postgres, snake_case (consumer-i's tables)",
  async () => {
    const pg = await freshBetterAuthSchema(withoutForeignKeys(CONSUMER_I_PG));
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, casing: "snake" });
    await s.migrate();
    return { adapter: s.storage, close: () => pg.close() };
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
  createdAt: at,
  updatedAt: at,
});
const eq = <F extends string>(field: F, value: unknown) => ({ field, op: "eq" as const, value });

describe("the Better Auth mapping on postgres", () => {
  let pg: { sql: Sql; close(): Promise<void> };
  let db: StorageAdapter;
  const raw = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    pg.sql.unsafe<T[]>(text, params as never[]);

  beforeEach(async () => {
    pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    await pg.sql.unsafe(BETTER_AUTH_ERA);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    expect(await s.migrate()).toEqual(["0001_compat_better_auth"]);
    expect(await s.migrate()).toEqual([]);
    db = s.storage;
  });
  afterEach(async () => {
    await pg.close();
  });

  it("serves core schema version 4; a new core version needs migration 0002 and a mapping change", () => {
    expect(SCHEMA_VERSION).toBe(4);
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
      await s.migrate();
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

  it("creates exactly two tables, ta_meta and ta_limit", async () => {
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
      expect(added).toEqual(["ta_limit", "ta_meta"]);
      expect(await pg.sql.unsafe("SELECT key, value FROM ta_meta ORDER BY key")).toEqual([
        { key: "compat_better_auth", value: "1" },
        { key: "schema_version", value: "4" },
      ]);
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
    await s.migrate();
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

  it("names the emailVerified column of the table, in both dialects", () => {
    const data = { ...user("u4", "x@example.com"), emailVerified: false };
    const snakeNames = resolveNames({ casing: "snake" });
    expect(compatStatements("sqlite", snakeNames).undoCreate("user", data)).toEqual({
      sql: 'DELETE FROM "user" WHERE "id" = ? AND "email_verified" = ?',
      params: ["u4", 0],
    });
    expect(st.undoCreate("user", user("u5", "y@example.com"))).toEqual({
      sql: 'DELETE FROM "user" WHERE "id" = $1',
      params: ["u5"],
    });
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
      createdAt: at,
      updatedAt: at,
    });
  };
  const count = async (table: string) =>
    (await pg.sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`))[0]?.n;

  beforeEach(async () => {
    pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await s.migrate();
    db = s.storage;
  });
  afterEach(async () => {
    await pg.close();
  });

  it("writes a sign-up's rows in core's order, user first", async () => {
    await db.transaction(signUpRows("user-first"));
    expect([await count("user"), await count("account"), await count("session")]).toEqual([
      1, 2, 1,
    ]);
    expect(await db.findOne("password", [eq("userId", "u1")])).toMatchObject({ id: "p1" });
  });

  it("refuses a password row before its user row, and keeps no row", async () => {
    await expect(db.transaction(signUpRows("password-first"))).rejects.toMatchObject({
      code: "23503",
      constraint_name: "account_userId_fkey",
    });
    expect([await count("user"), await count("account")]).toEqual([0, 0]);
  });
});
