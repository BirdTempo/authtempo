import { applyPostgresMigrations, createPostgresAdapter } from "@tempo-auth/adapter-postgres";
import { betterAuthSchemaStorage } from "@tempo-auth/compat-better-auth";
import { createMemoryAdapter, type StorageAdapter } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import betterAuthPg from "../../compat-better-auth/test/fixtures/better-auth-1.7.2.postgres.sql?raw";
import { importUsers } from "../src/import.js";
import { supabaseSource } from "../src/readers/supabase.js";
import identities from "./fixtures/supabase-identities.csv?raw";
import users from "./fixtures/supabase-users.csv?raw";
import { freshSchema } from "./pg.js";

const now = () => new Date("2026-10-11T00:00:00.000Z");
const source = () => supabaseSource({ users, identities, now });
/** Ada's bcrypt hash in the fixture. The importer keeps it as the export gives it. */
const ADA_HASH = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";

interface Target {
  storage: StorageAdapter;
  /** The hash column of the user's password row, read with SQL, not through the port. */
  storedHashes(userId: string): Promise<string[]>;
  close(): Promise<void>;
}

const targets: [string, () => Promise<Target>][] = [
  [
    "core's tables on adapter-postgres",
    async () => {
      const pg = await freshSchema();
      await applyPostgresMigrations(pg.sql);
      return {
        storage: createPostgresAdapter(pg.sql),
        storedHashes: async (userId) =>
          (await pg.sql`SELECT hash FROM ta_password WHERE user_id = ${userId}`).map(
            (r) => r.hash as string,
          ),
        close: pg.close,
      };
    },
  ],
  [
    "the Better Auth 1.7 tables on postgres, with their foreign keys (plan 9 mapping)",
    async () => {
      const pg = await freshSchema();
      await pg.sql.unsafe(betterAuthPg);
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await s.migrate();
      return {
        storage: s.storage,
        // Better Auth keeps the hash in account.password on the credential row.
        storedHashes: async (userId) =>
          (
            await pg.sql`SELECT "password" FROM "account" WHERE "providerId" = 'credential' AND "userId" = ${userId}`
          ).map((r) => r.password as string),
        close: pg.close,
      };
    },
  ],
];

for (const [label, open] of targets) {
  describe(`the importer on ${label}`, () => {
    it("imports the Supabase fixture, changes zero rows on the second run, and reports the same on a dry run", async () => {
      // The memory adapter is the reference: every storage must give its report.
      // The counts come from it, so a fixture row added later does not need an edit here.
      const reference = await importUsers(createMemoryAdapter(), source(), { now });
      expect(reference.created.user).toBeGreaterThanOrEqual(4);
      expect(reference.created.password).toBeGreaterThanOrEqual(2);
      const t = await open();
      try {
        const rows = async () => ({
          users: await t.storage.findMany("user", [], { sort: { field: "id", dir: "asc" } }),
          identities: await t.storage.findMany("identity", [], {
            sort: { field: "id", dir: "asc" },
          }),
          passwords: await t.storage.findMany("password", [], {
            sort: { field: "id", dir: "asc" },
          }),
        });
        const dry = await importUsers(t.storage, source(), { now, dryRun: true });
        expect(await rows()).toEqual({ users: [], identities: [], passwords: [] });
        const first = await importUsers(t.storage, source(), { now });
        expect({ ...dry, dryRun: false }).toEqual(first);
        expect(first).toEqual(reference);
        const before = await rows();
        expect(before.users).toHaveLength(first.created.user);
        expect(before.identities).toHaveLength(first.created.identity);
        expect(before.passwords).toHaveLength(first.created.password);
        const ada = await t.storage.findOne("user", [
          { field: "email", op: "eq", value: "ada@example.com" },
        ]);
        expect(ada).not.toBeNull();
        expect(await t.storedHashes(ada?.id ?? "")).toEqual([ADA_HASH]);
        const second = await importUsers(t.storage, source(), { now });
        expect(second.created).toEqual({
          user: 0,
          identity: 0,
          password: 0,
          passkey: 0,
          organization: 0,
          member: 0,
        });
        expect(second.exists.user).toBe(first.created.user);
        expect(second.partial).toEqual([]);
        expect(await rows()).toEqual(before);
      } finally {
        await t.close();
      }
    });
  });
}
