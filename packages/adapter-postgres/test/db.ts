import postgres, { type Sql } from "postgres";
import { applyPostgresMigrations } from "../src/migrations.js";

// The package has no @types/node, so type the one global this file reads.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;

export const PG_URL = env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";

async function createSchema(): Promise<string> {
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
  return name;
}

function client(schemaName: string): Sql {
  return postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: schemaName } });
}

/**
 * A fresh schema per call, with the migrations applied, on its own client.
 * Fails loudly when Postgres is not reachable: run `docker compose up -d`.
 * `max: 4` so a write outside an open transaction has a connection.
 */
export async function freshDatabase(): Promise<{ sql: Sql; close(): Promise<void> }> {
  const name = await createSchema();
  const sql = client(name);
  await applyPostgresMigrations(sql);
  return {
    sql,
    async close() {
      await sql.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * A fresh schema with the migrations applied, and a client on it whose pool
 * has `max` connections (plan 9h: the one-connection hang test). The
 * migrations run on a client of their own, so a pool of one holds no
 * connection when the test starts. `close` ends the client first, with a
 * 1-second timeout, because a hung transaction holds the only connection;
 * then it drops the schema on an admin client.
 */
export async function freshDatabaseOf(max: number): Promise<{ sql: Sql; close(): Promise<void> }> {
  const name = await createSchema();
  const setup = client(name);
  try {
    await applyPostgresMigrations(setup);
  } finally {
    await setup.end({ timeout: 5 });
  }
  const sql = postgres(PG_URL, { max, onnotice: () => {}, connection: { search_path: name } });
  return {
    sql,
    async close() {
      await sql.end({ timeout: 1 });
      const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`DROP SCHEMA ${name} CASCADE`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}

/**
 * A fresh, empty schema with no migrations applied, and two separate clients
 * on it. The two clients act as two replicas that deploy at the same time.
 */
export async function freshSchema(): Promise<{ a: Sql; b: Sql; close(): Promise<void> }> {
  const name = await createSchema();
  const a = client(name);
  const b = client(name);
  return {
    a,
    b,
    async close() {
      await a.unsafe(`DROP SCHEMA ${name} CASCADE`);
      await Promise.all([a.end({ timeout: 5 }), b.end({ timeout: 5 })]);
    },
  };
}
