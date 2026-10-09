import postgres, { type Sql } from "postgres";
import { applyPostgresMigrations } from "../src/migrations.js";

export const PG_URL =
  process.env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";

/**
 * A fresh schema per call, with the migrations applied, on its own client.
 * Fails loudly when Postgres is not reachable: run `docker compose up -d`.
 * `max: 4` so a write outside an open transaction has a connection.
 */
export async function freshDatabase(): Promise<{ sql: Sql; close(): Promise<void> }> {
  const name = `t_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE SCHEMA ${name}`);
  } catch (e) {
    throw new Error(
      `tempo-auth postgres tests need a database at ${PG_URL}: ${(e as Error).message}. Run: docker compose up -d`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: name } });
  await applyPostgresMigrations(sql);
  return {
    sql,
    async close() {
      await sql.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await sql.end({ timeout: 5 });
    },
  };
}
