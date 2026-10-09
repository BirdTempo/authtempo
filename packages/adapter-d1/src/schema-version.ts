import { SCHEMA_VERSION, StorageError } from "@tempo-auth/core";
import { META_TABLE, SCHEMA_VERSION_KEY } from "@tempo-auth/core/sql";

/**
 * Reads the schema version once. An older or missing version throws
 * schema_mismatch on every operation until the migrations run. A newer
 * version is accepted: a later migration must stay compatible with this
 * adapter until the adapter is updated.
 */
export function schemaVersionCheck(db: D1Database): () => Promise<void> {
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      let value: string | null = null;
      try {
        value = await db
          .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
          .bind(SCHEMA_VERSION_KEY)
          .first<string>("value");
      } catch {
        value = null;
      }
      const found = value === null ? Number.NaN : Number(value);
      if (!Number.isInteger(found) || found < SCHEMA_VERSION) {
        checked = null;
        throw new StorageError("schema_mismatch", "meta", [value ?? "none"]);
      }
    })();
    return checked;
  };
}
