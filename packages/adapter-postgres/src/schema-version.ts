import {
  assertSchemaValue,
  META_TABLE,
  SCHEMA_VERSION_KEY,
  schemaVersionGate,
} from "@authtempo/core/sql";
import type { Sql } from "postgres";

/** Postgres SQLSTATE for "undefined table". */
const UNDEFINED_TABLE = "42P01";

/**
 * One read of the stored schema version. Only an undefined table (42P01)
 * counts as "no version", because that means the migrations never ran.
 * Every other error passes through, so an outage never reads as "run the
 * migrations".
 */
async function readVersion(sql: Sql): Promise<string | null> {
  try {
    const rows = await sql.unsafe<{ value: string }[]>(
      `SELECT value FROM ${META_TABLE} WHERE key = $1`,
      [SCHEMA_VERSION_KEY],
    );
    return rows[0]?.value ?? null;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === UNDEFINED_TABLE) return null;
    throw e;
  }
}

/** The schema version check for Postgres, on the core gate. */
export function schemaVersionCheck(sql: Sql): () => Promise<void> {
  return schemaVersionGate(() => readVersion(sql));
}

/**
 * The `ping` of the adapter (plan 12h Task 8): the same read with no cache,
 * each call. It never sets the gate above.
 */
export function schemaVersionPing(sql: Sql): () => Promise<void> {
  return async () => assertSchemaValue(await readVersion(sql));
}
