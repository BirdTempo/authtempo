import { SCHEMA_VERSION } from "@authtempo/core";
import postgres, { type Sql } from "postgres";
import { MIGRATIONS } from "../src/migrations.js";

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
      `authtempo postgres tests need a database at ${PG_URL}: ${(e as Error).message}. Run: docker compose up -d`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  return name;
}

/**
 * The steps of `applyPostgresMigrations` without its advisory lock (ruling
 * 53 of plan 12k). It creates the table `ta_migrations`, then runs each
 * migration and its name row in its own transaction. Each test schema has
 * one owner, so the lock guards nothing here. The spec fixes the lock name,
 * so every schema of a database shares it. With the locked runner here,
 * each fixture waited on the migrations of every other suite on tempo_auth.
 * Measured on 2026-10-21 with 18 busy CPU loops and this suite in a loop, at
 * a load of 16 to 28. With the locked runner, tempo_auth had a mean of 5.34
 * and a maximum of 17 advisory lock waiters. With these steps, the mean was
 * 0.01 and the maximum 1. The import and CLI tests keep their own copy of
 * these steps. migrations.test.ts and conformance.test.ts still run the
 * locked runner, the product path.
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

function client(schemaName: string): Sql {
  return postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: schemaName } });
}

/**
 * A fresh schema per call, with the migrations applied, on its own client.
 * Fails loudly when Postgres is not reachable: run `docker compose up -d`.
 * `max: 4` so a write outside an open transaction has a connection.
 */
export async function freshDatabase(): Promise<{
  sql: Sql;
  close(): Promise<void>;
  stop(): Promise<void>;
}> {
  const name = await createSchema();
  const sql = client(name);
  await migrateWithoutLock(sql);
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
    await migrateWithoutLock(setup);
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

/**
 * A fresh schema with the migrations before the one of `SCHEMA_VERSION`
 * (plan 12h Task 8). An app has such a schema before it runs the new
 * migration. The files run as the runner runs them, with no record in
 * `ta_migrations`.
 */
export async function oldDatabase(): Promise<{ sql: Sql; close(): Promise<void> }> {
  const cut = MIGRATIONS.findIndex((m) =>
    m.name.startsWith(`${String(SCHEMA_VERSION).padStart(4, "0")}_`),
  );
  if (cut < 1) throw new Error(`no migration of version ${SCHEMA_VERSION}`);
  const db = await freshSchema();
  for (const m of MIGRATIONS.slice(0, cut)) await db.a.unsafe(m.sql);
  return { sql: db.a, close: () => db.close() };
}
