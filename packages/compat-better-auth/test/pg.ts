import postgres, { type Sql } from "postgres";

// The package has no @types/node, so type the one global this file reads.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;

export const PG_URL = env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";

/**
 * A fresh Postgres schema with `tables` (a fixture's SQL) applied and no
 * compat migration, on its own client. Fails loudly when Postgres is not
 * reachable: run `docker compose up -d`.
 */
export async function freshBetterAuthSchema(
  tables: string,
): Promise<{ sql: Sql; close(): Promise<void> }> {
  const name = `c_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE SCHEMA ${name}`);
  } catch (e) {
    throw new Error(
      `compat tests need a database at ${PG_URL}: ${(e as Error).message}. Run: docker compose up -d`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: name } });
  await sql.unsafe(tables);
  return {
    sql,
    async close() {
      await sql.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await sql.end({ timeout: 5 });
    },
  };
}
