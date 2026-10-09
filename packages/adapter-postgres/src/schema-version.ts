import { SCHEMA_VERSION, StorageError } from "@tempo-auth/core";
import { META_TABLE, SCHEMA_VERSION_KEY } from "@tempo-auth/core/sql";
import type { Sql } from "postgres";

/**
 * Reads the schema version once per adapter. An older or missing version
 * throws schema_mismatch on every operation until the migrations run. A
 * newer version is accepted: a later migration must stay compatible with
 * this adapter until the adapter is updated. A failed check is not kept,
 * so the next call reads again.
 */
export function schemaVersionCheck(sql: Sql): () => Promise<void> {
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      let value: string | null = null;
      try {
        const rows = await sql.unsafe<{ value: string }[]>(
          `SELECT value FROM ${META_TABLE} WHERE key = $1`,
          [SCHEMA_VERSION_KEY],
        );
        value = rows[0]?.value ?? null;
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
