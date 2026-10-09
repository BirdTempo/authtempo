import { META_TABLE, SCHEMA_VERSION_KEY, schemaVersionGate } from "@tempo-auth/core/sql";
import type { Sql } from "postgres";

/** Postgres SQLSTATE for "undefined table". */
const UNDEFINED_TABLE = "42P01";

/**
 * The schema version check for Postgres, on the core gate. Only an undefined
 * table (42P01) counts as "no version", because that means the migrations
 * never ran. Every other error passes through, so an outage never reads as
 * "run the migrations".
 */
export function schemaVersionCheck(sql: Sql): () => Promise<void> {
  return schemaVersionGate(async () => {
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
  });
}
