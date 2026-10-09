import type { Sql } from "postgres";
import * as m0001 from "./migrations/0001_schema_v1.js";

export interface Migration {
  name: string;
  sql: string;
}

/** Every migration in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [{ name: m0001.name, sql: m0001.sql }];

const TABLE = "ta_migrations";

/**
 * Applies the migrations that `ta_migrations` does not list yet, each in its
 * own transaction, in order. Returns the names it applied. Safe to run on
 * every deploy.
 */
export async function applyPostgresMigrations(sql: Sql): Promise<string[]> {
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const done = new Set(
    (await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${TABLE}`)).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx.unsafe(`INSERT INTO ${TABLE} (name) VALUES ($1)`, [m.name]);
    });
    applied.push(m.name);
  }
  return applied;
}
