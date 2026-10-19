import type { Sql } from "postgres";
import * as m0001 from "./migrations/0001_schema_v1.js";
import * as m0002 from "./migrations/0002_schema_v2.js";
import * as m0003 from "./migrations/0003_schema_v3.js";
import * as m0004 from "./migrations/0004_schema_v4.js";
import * as m0005 from "./migrations/0005_schema_v5.js";
import * as m0006 from "./migrations/0006_schema_v6.js";
import * as m0007 from "./migrations/0007_schema_v7.js";
import * as m0008 from "./migrations/0008_schema_v8.js";
import * as m0009 from "./migrations/0009_schema_v9.js";
import * as m0010 from "./migrations/0010_schema_v10.js";
import * as m0011 from "./migrations/0011_schema_v11.js";

export interface Migration {
  name: string;
  sql: string;
}

/** Every migration in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  { name: m0001.name, sql: m0001.sql },
  { name: m0002.name, sql: m0002.sql },
  { name: m0003.name, sql: m0003.sql },
  { name: m0004.name, sql: m0004.sql },
  { name: m0005.name, sql: m0005.sql },
  { name: m0006.name, sql: m0006.sql },
  { name: m0007.name, sql: m0007.sql },
  { name: m0008.name, sql: m0008.sql },
  { name: m0009.name, sql: m0009.sql },
  { name: m0010.name, sql: m0010.sql },
  { name: m0011.name, sql: m0011.sql },
];

const TABLE = "ta_migrations";

/** One fixed advisory lock key for every authtempo migration run. */
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('tempo_auth_migrations'))";

/**
 * Applies the migrations that `ta_migrations` does not list yet, each in its
 * own transaction, in order. Returns the names it applied. Safe to run on
 * every deploy, also from two replicas at once: each migration transaction
 * first takes one advisory lock, then reads the applied names again under
 * the lock. A second runner waits for the first and then skips its work.
 * Without the lock, two runners both see an empty list and one fails on
 * CREATE TABLE, so the deploy fails.
 */
export async function applyPostgresMigrations(sql: Sql): Promise<string[]> {
  // Two concurrent CREATE TABLE IF NOT EXISTS can still collide in the
  // catalog, so this statement also runs under the lock.
  await sql.begin(async (tx) => {
    await tx.unsafe(LOCK);
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
  });
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    const ran = await sql.begin(async (tx) => {
      await tx.unsafe(LOCK);
      const done = await tx.unsafe<{ name: string }[]>(`SELECT 1 FROM ${TABLE} WHERE name = $1`, [
        m.name,
      ]);
      if (done.length > 0) return false;
      await tx.unsafe(m.sql);
      await tx.unsafe(`INSERT INTO ${TABLE} (name) VALUES ($1)`, [m.name]);
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return applied;
}
