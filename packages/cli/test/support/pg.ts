import { MIGRATIONS } from "@authtempo/adapter-postgres";
import postgres, { type Sql } from "postgres";

export const ADMIN_URL =
  process.env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";

/**
 * A fresh, empty database and its connection string (plan 11c): a child
 * process of the CLI connects by URL, so a schema on a shared database is
 * not enough. Fails loudly when Postgres is not reachable: run
 * `docker compose up -d`.
 */
export async function freshDatabase(): Promise<{ url: string; sql: Sql; drop(): Promise<void> }> {
  const name = `cli_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (e) {
    throw new Error(
      `the CLI tests need Postgres at ${ADMIN_URL}: ${(e as Error).message}. Run: docker compose up -d`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  return {
    url,
    sql,
    async drop() {
      await sql.end({ timeout: 5 });
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end({ timeout: 5 });
      }
    },
  };
}

/**
 * The schema one version below the CLI's (plan 11f Task 3): every core
 * migration but the last. It repeats the steps of `applyPostgresMigrations`
 * of `@authtempo/adapter-postgres`: the table `ta_migrations`, then each
 * migration's `sql` and its name row. No lock: one test owns the database.
 */
export async function applyOneVersionBelow(sql: Sql): Promise<void> {
  await sql.unsafe(
    "CREATE TABLE IF NOT EXISTS ta_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const m of MIGRATIONS.slice(0, -1)) {
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx.unsafe("INSERT INTO ta_migrations (name) VALUES ($1)", [m.name]);
    });
  }
}
