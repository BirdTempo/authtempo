import { MIGRATIONS } from "@authtempo/adapter-postgres";
import postgres, { type Sql } from "postgres";

export const ADMIN_URL =
  process.env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";

/** A test database older than one hour is left by a killed run, so the first fresh database drops it. */
const STALE_AFTER_MS = 60 * 60 * 1000;
/** The id form of `testId`: the creation time in ms, then a random part. */
const ID_RE = /^(\d{13})_[0-9a-f]{8}$/;
/** The id form before 2026-10-22, which holds no time. */
const LEGACY_ID_RE = /^[0-9a-f]{32}$/;

/** The id of a new test database `cli_<id>`. A sweep reads the age from it. */
export function testId(now = Date.now()): string {
  return `${now}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/**
 * Drops each test database that is older than one hour and has no open
 * connection, and answers the names. A killed run never drops its database,
 * and 1249 of them made each CREATE and DROP slow (the form of the MySQL
 * sweep of plan 12g). A database of the legacy id form is old when its
 * PG_VERSION file is. The DROP has no FORCE: Postgres refuses a database
 * that a connection opens between the read and the drop, and the sweep
 * then keeps it.
 */
export async function dropStaleDatabases(now = Date.now()): Promise<string[]> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin.unsafe<{ name: string; ageMs: number | null }[]>(
      `SELECT d.datname AS name,
        (extract(epoch FROM now() - (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification) * 1000)::float8 AS "ageMs"
      FROM pg_database d
      WHERE d.datname LIKE 'cli\\_%'
        AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    );
    const dropped: string[] = [];
    for (const r of rows) {
      const id = r.name.slice("cli_".length);
      const made = ID_RE.exec(id)?.[1];
      const old =
        made !== undefined
          ? now - Number(made) > STALE_AFTER_MS
          : LEGACY_ID_RE.test(id) && r.ageMs !== null && r.ageMs > STALE_AFTER_MS;
      if (!old) continue;
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${r.name}`);
        dropped.push(r.name);
      } catch (e) {
        // 55006 object_in_use: a connection opened after the read.
        if ((e as { code?: unknown }).code !== "55006") throw e;
      }
    }
    return dropped.sort();
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** One sweep in each test file, before its first fresh database. */
let sweep: Promise<string[]> | undefined;

/** The databases of this test file that no `drop` has removed yet. */
const live = new Map<string, () => Promise<void>>();

/**
 * Drops each database of this test file that is still there. The setup
 * file runs it in an afterAll, so a test that times out before its own
 * `drop` leaves no database.
 */
export async function dropLiveDatabases(): Promise<void> {
  for (const drop of [...live.values()]) await drop();
}

/**
 * A fresh, empty database and its connection string (plan 11c): a child
 * process of the CLI connects by URL, so a schema on a shared database is
 * not enough. The first call drops the stale databases of killed runs.
 * `id` names the database of a sweep test. Fails loudly when Postgres is
 * not reachable: run `docker compose up -d`.
 */
export async function freshDatabase(
  opts: { id?: string } = {},
): Promise<{ name: string; url: string; sql: Sql; drop(): Promise<void> }> {
  sweep ??= dropStaleDatabases();
  await sweep.catch((e: unknown) => {
    throw new Error(
      `the CLI tests need Postgres at ${ADMIN_URL}: ${(e as Error).message}. Run: docker compose up -d`,
    );
  });
  const name = `cli_${opts.id ?? testId()}`;
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
  const drop = async () => {
    await sql.end({ timeout: 5 });
    const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await a.end({ timeout: 5 });
    }
    live.delete(name);
  };
  live.set(name, drop);
  return { name, url, sql, drop };
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
