import postgres, { type Sql } from "postgres";
import { compatPostgresSteps } from "../src/storage/migration.js";
import type { Names } from "../src/storage/names.js";

// The package has no @types/node, so type the one global this file reads.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;

/** The address of a test server: `node scripts/test-servers.mjs up` writes it, and `pnpm test` passes it. */
function serverUrl(name: string): string {
  const url = env[name];
  if (url === undefined || url === "")
    throw new Error(
      `${name} is not set. Run: node scripts/test-servers.mjs up (pnpm test runs it for you)`,
    );
  return url;
}

export const PG_URL = serverUrl("TEMPO_AUTH_PG_URL");

/**
 * A fresh Postgres schema with `tables` (a fixture's SQL) applied and no
 * compat migration, on its own client. Fails loudly when Postgres is not
 * reachable: run `node scripts/test-servers.mjs up`.
 */
export async function freshBetterAuthSchema(
  tables: string,
): Promise<{ sql: Sql; close(): Promise<void>; stop(): Promise<void> }> {
  const name = `c_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE SCHEMA ${name}`);
  } catch (e) {
    throw new Error(
      `compat tests need a database at ${PG_URL}: ${(e as Error).message}. Run: node scripts/test-servers.mjs up`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: name } });
  await sql.unsafe(tables);
  let stopped = false;
  return {
    sql,
    async close() {
      if (stopped) {
        // The client has ended, so an admin client drops the schema.
        const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
        try {
          await admin.unsafe(`DROP SCHEMA ${name} CASCADE`);
        } finally {
          await admin.end({ timeout: 5 });
        }
        return;
      }
      await sql.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await sql.end({ timeout: 5 });
    },
    /** Ends the client, as a database that stops: the next query throws (plan 12h Task 8). */
    async stop() {
      stopped = true;
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * The steps of the compat runner (`migrate()`) without its advisory lock,
 * on a schema with no compat migration (ruling 53 of plan 12k). Each step
 * runs in its own transaction, from the list that the runner reads. Each
 * test schema has one owner, so the lock guards nothing here. The spec
 * fixes the lock name, so every schema of tempo_auth shares it. Each fixture
 * then waited on the compat migrations of every other file. Evidence run 2
 * of 3d0b2044 (2026-10-21, load 24) failed one teams.test.ts case on that
 * wait at 5 s. With these steps, teams.test.ts passed 10 of 10 runs beside
 * 18 busy CPU loops and the adapter-postgres suite in a loop. The tests that
 * check what migrate() answers still call it, the product path.
 */
export async function migrateWithoutLock(sql: Sql, names: Names): Promise<void> {
  for (const m of compatPostgresSteps(names)) {
    await sql.begin(async (tx) => {
      await tx.unsafe(m.text);
    });
  }
}
