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
import * as m0012 from "./migrations/0012_schema_v12.js";
import * as m0013 from "./migrations/0013_schema_v13.js";

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
  { name: m0012.name, sql: m0012.sql },
  { name: m0013.name, sql: m0013.sql },
];

const TABLE = "ta_migrations";

/**
 * The statement that takes the advisory lock of one migration step. The key
 * names the schema that the step migrates. That is current_schema(), the
 * first schema of the search_path that exists, where an unqualified CREATE
 * TABLE lands. So two runs on one schema wait in turn. Runs on two schemas
 * of one database never wait on each other (ruling 52 of plan 12k). A key
 * with no schema made every migration of the database wait on every other,
 * and test migrations timed out under load. With no schema in the
 * search_path, coalesce still takes a lock, and the step then fails at its
 * first CREATE. The compat runner calls it with its own name. `name` is a
 * fixed name of this repo, never input.
 */
export function migrationLockSql(name: string): string {
  return `SELECT pg_advisory_xact_lock(hashtext('${name}:' || coalesce(current_schema(), '')))`;
}

const LOCK = migrationLockSql("tempo_auth_migrations");

/**
 * Applies the migrations that `ta_migrations` does not list yet, each in its
 * own transaction, in order. Returns the names it applied. Safe to run on
 * every deploy, also from two replicas at once: each migration transaction
 * first takes the advisory lock of its schema, then reads the applied names
 * again under the lock. A second runner waits for the first and then skips its work.
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
