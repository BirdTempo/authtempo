import { META_TABLE, SCHEMA_VERSION_KEY, schemaVersionGate } from "@authtempo/core/sql";

/**
 * The schema version check for D1, on the core gate. Only a missing table
 * ("no such table") counts as "no version", because that means the migrations
 * never ran. Every other error passes through, so a D1 outage never reads as
 * "run the migrations".
 */
export function schemaVersionCheck(db: D1Database): () => Promise<void> {
  return schemaVersionGate(async () => {
    try {
      return await db
        .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
        .bind(SCHEMA_VERSION_KEY)
        .first<string>("value");
    } catch (e) {
      if (e instanceof Error && e.message.includes("no such table")) return null;
      throw e;
    }
  });
}
