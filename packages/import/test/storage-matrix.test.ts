import { applyPostgresMigrations, createPostgresAdapter } from "@tempo-auth/adapter-postgres";
import { betterAuthSchemaStorage } from "@tempo-auth/compat-better-auth";
import { createMemoryAdapter, type StorageAdapter } from "@tempo-auth/core";
import { LEGACY_FORMATS } from "@tempo-auth/legacy-hashes";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import betterAuthPg from "../../compat-better-auth/test/fixtures/better-auth-1.7.2.postgres.sql?raw";
import { importUsers } from "../src/import.js";
import { supabaseSource } from "../src/readers/supabase.js";
import type { ImportOptions, ImportReport, Source } from "../src/types.js";
import {
  GOOGLE_SUBJECT,
  HASHES,
  MARKER,
  matrixSource,
  PASSKEY,
  PASSKEY_PUBLIC_KEY_STD,
} from "./fixtures/matrix.js";
import { SUPABASE_FIXTURE_CREATED } from "./fixtures/supabase-counts.js";
import identities from "./fixtures/supabase-identities.csv?raw";
import users from "./fixtures/supabase-users.csv?raw";
import { freshSchema } from "./pg.js";

const now = () => new Date("2026-10-11T00:00:00.000Z");

/** The reads of one target's own tables, with SQL, not through the port. */
interface Reads {
  userId(email: string): Promise<string>;
  hashes(userId: string): Promise<string[]>;
  identities(userId: string): Promise<{ provider: string; subject: string }[]>;
  organizations(): Promise<{ id: string; slug: string; name: string }[]>;
  members(organizationId: string): Promise<{ userId: string; role: string }[]>;
  passkeys(userId: string): Promise<{ credentialId: string; publicKey: string; counter: number }[]>;
}

interface Target {
  storage: StorageAdapter;
  sql: Sql;
  read: Reads;
  /** PASSKEY.publicKey as this target's table stores it. */
  storedPublicKey: string;
  /** Better Auth only: every account row of the user, credential row included. */
  accounts?(userId: string): Promise<{ providerId: string; accountId: string }[]>;
  close(): Promise<void>;
}

const plain = <T>(rows: readonly T[]): T[] => [...rows];

/** A fresh schema, set up by `setup`. A setup that throws drops the schema and ends the client. */
async function schema(
  setup: (sql: Sql) => Promise<Omit<Target, "sql" | "close">>,
): Promise<Target> {
  const pg = await freshSchema();
  try {
    return { ...(await setup(pg.sql)), sql: pg.sql, close: pg.close };
  } catch (e) {
    await pg.close();
    throw e;
  }
}

const targets: [string, () => Promise<Target>][] = [
  [
    "core's tables on adapter-postgres",
    () =>
      schema(async (sql) => {
        await applyPostgresMigrations(sql);
        return {
          storage: createPostgresAdapter(sql),
          storedPublicKey: PASSKEY.publicKey,
          read: {
            userId: async (email) =>
              (await sql<{ id: string }[]>`SELECT id FROM ta_user WHERE email = ${email}`)[0]?.id ??
              "",
            hashes: async (userId) =>
              (
                await sql<
                  { hash: string }[]
                >`SELECT hash FROM ta_password WHERE user_id = ${userId}`
              ).map((r) => r.hash),
            identities: async (userId) =>
              plain(
                await sql<{ provider: string; subject: string }[]>`
                  SELECT provider, subject FROM ta_identity WHERE user_id = ${userId}
                  ORDER BY provider, subject`,
              ),
            organizations: async () =>
              plain(
                await sql<{ id: string; slug: string; name: string }[]>`
                  SELECT id, slug, name FROM ta_organization ORDER BY slug`,
              ),
            members: async (organizationId) =>
              plain(
                await sql<{ userId: string; role: string }[]>`
                  SELECT user_id AS "userId", role FROM ta_member
                  WHERE organization_id = ${organizationId} ORDER BY role`,
              ),
            passkeys: async (userId) =>
              plain(
                await sql<{ credentialId: string; publicKey: string; counter: number }[]>`
                  SELECT credential_id AS "credentialId", public_key AS "publicKey",
                    counter::int AS counter
                  FROM ta_passkey WHERE user_id = ${userId}`,
              ),
          },
        };
      }),
  ],
  [
    "the Better Auth 1.7 tables on postgres, with their foreign keys (plan 9 mapping)",
    () =>
      schema(async (sql) => {
        await sql.unsafe(betterAuthPg);
        const s = betterAuthSchemaStorage({ dialect: "postgres", sql });
        await s.migrate();
        return {
          storage: s.storage,
          storedPublicKey: PASSKEY_PUBLIC_KEY_STD,
          read: {
            userId: async (email) =>
              (await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`)[0]?.id ??
              "",
            // Better Auth keeps the hash in account.password on the credential row.
            hashes: async (userId) =>
              (
                await sql<{ hash: string }[]>`
                  SELECT "password" AS hash FROM "account"
                  WHERE "providerId" = 'credential' AND "userId" = ${userId}`
              ).map((r) => r.hash),
            identities: async (userId) =>
              plain(
                await sql<{ provider: string; subject: string }[]>`
                  SELECT "providerId" AS provider, "accountId" AS subject FROM "account"
                  WHERE "userId" = ${userId} AND "providerId" <> 'credential'
                  ORDER BY 1, 2`,
              ),
            organizations: async () =>
              plain(
                await sql<{ id: string; slug: string; name: string }[]>`
                  SELECT id, slug, name FROM "organization" ORDER BY slug`,
              ),
            members: async (organizationId) =>
              plain(
                await sql<{ userId: string; role: string }[]>`
                  SELECT "userId", role FROM "member"
                  WHERE "organizationId" = ${organizationId} ORDER BY role`,
              ),
            passkeys: async (userId) =>
              plain(
                await sql<{ credentialId: string; publicKey: string; counter: number }[]>`
                  SELECT "credentialID" AS "credentialId", "publicKey", counter
                  FROM "passkey" WHERE "userId" = ${userId}`,
              ),
          },
          accounts: async (userId) =>
            plain(
              await sql<{ providerId: string; accountId: string }[]>`
                SELECT "providerId", "accountId" FROM "account"
                WHERE "userId" = ${userId} ORDER BY "providerId"`,
            ),
        };
      }),
  ],
];

/**
 * Every table in the schema, with SQL: the row count and an md5 of the rows
 * as text in order. It sees a column the port does not map, so a second run
 * that writes anything, through any model, changes it.
 */
async function snapshot(sql: Sql): Promise<Record<string, { rows: number; digest: string }>> {
  const tables = await sql<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`;
  const out: Record<string, { rows: number; digest: string }> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const [row] = await sql.unsafe<{ rows: number; digest: string }[]>(
      `SELECT count(*)::int AS rows,
        coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') AS digest
      FROM ${quoted} t`,
    );
    out[name] = row ?? { rows: -1, digest: "" };
  }
  return out;
}

/**
 * What run two must report. A record that exists is counted in `exists` and
 * gives nothing else, so its drops, its refused hash, and the member skips of
 * its organization are not listed again. A skipped user or organization is
 * skipped again, in the same order, with the same refusal count.
 */
function secondReport(first: ImportReport): ImportReport {
  return {
    ...first,
    created: { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 },
    exists: { user: first.created.user, organization: first.created.organization },
    skipped: first.skipped.filter((s) => s.kind !== "member"),
    refusedHashes: [],
    dropped: [],
    partial: [],
  };
}

/**
 * Review Focus 4 on one target: a dry run writes nothing and reports what the
 * real run reports, the real run reports what the memory adapter reports, and
 * a second run changes no row in any table and reports every record as found.
 */
async function runTwice(t: Target, source: () => Source, options: ImportOptions) {
  const reference = await importUsers(createMemoryAdapter(), source(), options);
  const empty = await snapshot(t.sql);
  const dry = await importUsers(t.storage, source(), { ...options, dryRun: true });
  expect(await snapshot(t.sql)).toEqual(empty);
  const first = await importUsers(t.storage, source(), options);
  expect({ ...dry, dryRun: false }).toEqual(first);
  expect(first).toEqual(reference);
  const before = await snapshot(t.sql);
  expect(before).not.toEqual(empty);
  const second = await importUsers(t.storage, source(), options);
  expect(second).toEqual(secondReport(first));
  expect(await snapshot(t.sql)).toEqual(before);
  return first;
}

for (const [label, open] of targets) {
  describe(`the importer on ${label}`, () => {
    it("imports the Supabase export, changes zero rows on the second run, and reports the same on a dry run", async () => {
      const t = await open();
      try {
        const source = () => supabaseSource({ users, identities, now });
        const first = await runTwice(t, source, { formats: LEGACY_FORMATS, now });
        // Exact counts, so a run that imports nothing does not pass against an empty reference.
        expect(first.created).toMatchObject(SUPABASE_FIXTURE_CREATED);
        const ada = await t.read.userId("ada@example.com");
        expect(await t.read.hashes(ada)).toEqual([HASHES.ada]);
      } finally {
        await t.close();
      }
    });

    it("writes each record kind as its tables store it: tagged hashes, the marker, identities, a passkey, an organization and its members", async () => {
      const t = await open();
      try {
        const first = await runTwice(t, matrixSource, {
          formats: LEGACY_FORMATS,
          now,
          legacyVerify: true,
        });
        expect(first.created).toEqual({
          user: 5,
          identity: 5,
          password: 4,
          passkey: 1,
          organization: 1,
          member: 3,
        });
        const id = {
          ada: await t.read.userId("ada@example.com"),
          fire: await t.read.userId("fire@example.com"),
          cog: await t.read.userId("cog@example.com"),
          pk: await t.read.userId("pk@example.com"),
          bob: await t.read.userId("bob@example.com"),
        };
        for (const v of Object.values(id)) expect(v).not.toBe("");
        // The password column holds each tagged string as the export gives it, and the marker as core defines it.
        expect(await t.read.hashes(id.ada)).toEqual([HASHES.ada]);
        expect(await t.read.hashes(id.fire)).toEqual([HASHES.fire]);
        expect(HASHES.fire.startsWith("$firescrypt$")).toBe(true);
        expect(await t.read.hashes(id.cog)).toEqual([MARKER]);
        expect(await t.read.hashes(id.bob)).toEqual([HASHES.bob]);
        expect(await t.read.hashes(id.pk)).toEqual([]);
        // A verified user has its email identity; an unverified one has none.
        expect(await t.read.identities(id.ada)).toEqual([
          { provider: "email", subject: "ada@example.com" },
          { provider: "google", subject: GOOGLE_SUBJECT },
        ]);
        expect(await t.read.identities(id.cog)).toEqual([
          { provider: "email", subject: "cog@example.com" },
        ]);
        expect(await t.read.identities(id.bob)).toEqual([]);
        if (t.accounts) {
          // Better Auth finds the rows by providerId; the credential row's accountId is the user id.
          expect(await t.accounts(id.ada)).toEqual([
            { providerId: "credential", accountId: id.ada },
            { providerId: "email", accountId: "ada@example.com" },
            { providerId: "google", accountId: GOOGLE_SUBJECT },
          ]);
        }
        expect(await t.read.passkeys(id.pk)).toEqual([
          {
            credentialId: PASSKEY.credentialId,
            publicKey: t.storedPublicKey,
            counter: PASSKEY.counter,
          },
        ]);
        const orgs = await t.read.organizations();
        expect(orgs.map(({ slug, name }) => ({ slug, name }))).toEqual([
          { slug: "matrix-org", name: "Matrix Org" },
        ]);
        expect(await t.read.members(orgs[0]?.id ?? "")).toEqual([
          { userId: id.pk, role: "admin" },
          { userId: id.cog, role: "member" },
          { userId: id.ada, role: "owner" },
        ]);
      } finally {
        await t.close();
      }
    });
  });
}
