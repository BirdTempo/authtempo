import { MIGRATIONS } from "@authtempo/adapter-postgres";
import postgres, { type Sql } from "postgres";

export const ADMIN_URL =
  process.env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";

/** The name prefix of each CLI test database. The sweep of a normal run acts on it only. */
export const PREFIX = "cli_";
/** A test database older than one hour is left by a killed run, so the first fresh database drops it. */
const STALE_AFTER_MS = 60 * 60 * 1000;
/** The id form of `testId`: the creation time in ms, then a random part. */
const ID_RE = /^(\d{13})_[0-9a-f]{8}$/;
/** The id form before 2026-10-22, which holds no time. */
const LEGACY_ID_RE = /^[0-9a-f]{32}$/;
/**
 * A DROP waits at most this long for a lock. A session in a transaction that
 * holds the database (for example after COMMENT ON DATABASE) blocks the DROP,
 * and with no bound one blocked drop uses up the 180 s hook limit.
 */
const LOCK_TIMEOUT_MS = 5_000;

/** One admin connection whose DROP stops at the lock bound. A CREATE needs no bound. */
function connect(url: string): Sql {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { lock_timeout: LOCK_TIMEOUT_MS },
  });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The id of a new test database `cli_<id>`. A sweep reads the age from it. */
export function testId(now = Date.now()): string {
  return `${now}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

export interface SweepOptions {
  /**
   * The name prefix the sweep acts on, `cli_` by default. A sweep test gives
   * a prefix of its own, so the test and each break of it act only on
   * databases that the test made.
   */
  prefix?: string;
  /** The age above which a test database is stale. */
  staleAfterMs?: number;
  now?: number;
  url?: string;
  /** Runs after the list read and before the age read. A test drops a database there. */
  afterList?: () => Promise<void>;
}

/**
 * The names of the stale test databases: each name with the prefix and no
 * open connection, older than the bound. A database of the legacy id form is
 * as old as its PG_VERSION file. The age read has missing_ok, so a database
 * that a parallel run drops after the list read gives no age and stays. A
 * user that is not a superuser cannot read the file (42501): then no legacy
 * database is stale, and one warning tells why.
 */
export async function staleDatabases(opts: SweepOptions = {}): Promise<string[]> {
  const prefix = opts.prefix ?? PREFIX;
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const now = opts.now ?? Date.now();
  const admin = connect(opts.url ?? ADMIN_URL);
  try {
    const rows = await admin.unsafe<{ name: string; oid: string }[]>(
      `SELECT d.datname AS name, d.oid::text AS oid
      FROM pg_database d
      WHERE starts_with(d.datname, $1)
        AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
      [prefix],
    );
    await opts.afterList?.();
    const stale: string[] = [];
    const legacy = new Map<string, string>();
    for (const r of rows) {
      const id = r.name.slice(prefix.length);
      const made = ID_RE.exec(id)?.[1];
      if (made !== undefined) {
        if (now - Number(made) > staleAfterMs) stale.push(r.name);
      } else if (LEGACY_ID_RE.test(id)) {
        legacy.set(r.oid, r.name);
      }
    }
    if (legacy.size > 0) {
      try {
        const ages = await admin.unsafe<{ oid: string; ageMs: number | null }[]>(
          `SELECT o AS oid,
            (extract(epoch FROM now() - (pg_stat_file('base/' || o || '/PG_VERSION', true)).modification) * 1000)::float8 AS "ageMs"
          FROM unnest($1::text[]) AS o`,
          [[...legacy.keys()]],
        );
        for (const a of ages) {
          const name = legacy.get(a.oid);
          if (name !== undefined && a.ageMs !== null && a.ageMs > staleAfterMs) stale.push(name);
        }
      } catch (e) {
        console.warn(
          `the sweep of the ${prefix} test databases cannot read the age of ${legacy.size} legacy databases, so it keeps them: ${message(e)}`,
        );
      }
    }
    return stale.sort();
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Drops each named database and answers the dropped names. The DROP has no
 * FORCE: Postgres refuses a database that a connection opened after the list
 * read (55006 object_in_use), and it stays. Another failure does not stop
 * the loop; the call reports all of them at the end.
 */
export async function dropUnused(names: string[], url = ADMIN_URL): Promise<string[]> {
  const admin = connect(url);
  const dropped: string[] = [];
  const failures: string[] = [];
  try {
    for (const name of names) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
        dropped.push(name);
      } catch (e) {
        if ((e as { code?: unknown }).code !== "55006") failures.push(`${name}: ${message(e)}`);
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (failures.length > 0) throw new Error(`the drop failed for ${failures.join("; ")}`);
  return dropped;
}

/**
 * Drops each stale test database and answers the names. A killed run never
 * drops its database, and 1249 of them made each CREATE and DROP slow (the
 * form of the MySQL sweep of plan 12g).
 */
export async function dropStaleDatabases(opts: SweepOptions = {}): Promise<string[]> {
  return dropUnused(await staleDatabases(opts), opts.url ?? ADMIN_URL);
}

/**
 * One sweep for each URL and prefix in each test file, before its first
 * fresh database. The promise never rejects: a sweep error writes one
 * warning, and the tests go on.
 */
const sweeps = new Map<string, Promise<void>>();

/** The databases of this test file that no `drop` has removed yet. */
const live = new Map<string, () => Promise<void>>();

/**
 * Drops each database of this test file that is still there. The setup
 * file runs it in an afterAll, so a test that times out before its own
 * `drop` leaves no database. A failed drop does not stop the loop; the call
 * reports all failures at the end.
 */
export async function dropLiveDatabases(): Promise<void> {
  const failures: string[] = [];
  for (const [name, drop] of [...live]) {
    try {
      await drop();
    } catch (e) {
      failures.push(`${name}: ${message(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} test databases stay on the server: ${failures.join("; ")}`);
  }
}

/**
 * A fresh, empty database and its connection string (plan 11c): a child
 * process of the CLI connects by URL, so a schema on a shared database is
 * not enough. The first call drops the stale databases of killed runs.
 * `id` names the database of a sweep test, and `prefix` and `url` keep a
 * sweep test apart from the databases of other runs. Fails loudly when
 * Postgres is not reachable: run `docker compose up -d`.
 */
export async function freshDatabase(
  opts: { id?: string; prefix?: string; url?: string } = {},
): Promise<{ name: string; url: string; sql: Sql; drop(): Promise<void> }> {
  const prefix = opts.prefix ?? PREFIX;
  const adminUrl = opts.url ?? ADMIN_URL;
  const key = `${prefix} ${adminUrl}`;
  let sweep = sweeps.get(key);
  if (sweep === undefined) {
    sweep = dropStaleDatabases({ prefix, url: adminUrl }).then(
      () => {},
      (e: unknown) => {
        console.warn(`the sweep of the stale ${prefix} test databases stopped: ${message(e)}`);
      },
    );
    sweeps.set(key, sweep);
  }
  await sweep;
  const name = `${prefix}${opts.id ?? testId()}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (e) {
    throw new Error(
      `the CLI tests need Postgres at ${adminUrl}: ${message(e)}. Run: docker compose up -d`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = adminUrl.replace(/\/[^/]+$/, `/${name}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const drop = async () => {
    await sql.end({ timeout: 5 });
    const a = connect(adminUrl);
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
