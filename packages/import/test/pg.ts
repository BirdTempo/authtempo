import { MIGRATIONS } from "@authtempo/adapter-postgres";
import postgres, { type Sql } from "postgres";

/** The address of a test server: `node scripts/test-servers.mjs up` writes it, and `pnpm test` passes it. */
function serverUrl(name: string): string {
  const url = process.env[name];
  if (url === undefined || url === "")
    throw new Error(
      `${name} is not set. Run: node scripts/test-servers.mjs up (pnpm test runs it for you)`,
    );
  return url;
}

export const PG_URL = serverUrl("TEMPO_AUTH_PG_URL");

/** A fresh, empty Postgres schema on its own client. Fails loudly when Postgres is not reachable: run `node scripts/test-servers.mjs up`. */
export async function freshSchema(): Promise<{ sql: Sql; close(): Promise<void> }> {
  const name = `i_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE SCHEMA ${name}`);
  } catch (e) {
    throw new Error(
      `import tests need a database at ${PG_URL}: ${(e as Error).message}. Run: node scripts/test-servers.mjs up`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: name } });
  return {
    sql,
    async close() {
      await sql.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Core's migrations in the schema of `sql`: the steps of
 * `applyPostgresMigrations`, without its advisory lock. The CLI tests use the
 * same steps (applyOneVersionBelow). Postgres shares that lock across all
 * schemas of a database. On tempo_auth, each migration run of this file
 * waits for the migration runs of every adapter-postgres test, 14 lock
 * waits a run. This schema has one owner, so the lock guards nothing here.
 * Measured on 2026-10-21 (plan 12k, 18 cores, a load of 20 to 25, the
 * adapter-postgres suite in a loop beside it): the locked run took up to
 * 8.1 s and failed the 5 s timeout in 3 of 10 file runs. The run without
 * the lock took at most 0.62 s, and 10 of 10 file runs passed.
 */
export async function migrateWithoutLock(sql: Sql): Promise<void> {
  await sql.unsafe(
    "CREATE TABLE ta_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const m of MIGRATIONS) {
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx.unsafe("INSERT INTO ta_migrations (name) VALUES ($1)", [m.name]);
    });
  }
}
