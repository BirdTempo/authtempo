import { type ModelName, StorageError } from "@authtempo/core";
import { fieldsFromColumns, fieldsFromUniqueIndex } from "@authtempo/core/sql";

/** MySQL error numbers that the adapter maps (MySQL 8.4 server error reference). */
const DUP_ENTRY = 1062;
/** A value longer than its column (decision 3 of plan 12g). */
const DATA_TOO_LONG = 1406;
/** A value that the column's character set cannot hold. */
const TRUNCATED_WRONG_VALUE = 1366;
/** The same fault through a prepared statement on 8.4 and 9.7 (N4 of the 12g open file). */
const IMPOSSIBLE_STRING_CONVERSION = 3988;

/** The field of the column that the message names (`for column 'email'`), or none. */
function fieldOf(model: ModelName, message: string): string[] {
  const column = /for column '([^']+)'/.exec(message)?.[1];
  return column === undefined ? [] : fieldsFromColumns(model, [column]);
}

/**
 * Maps a mysql2 error to a StorageError, or null for any other error. The
 * StorageError holds the code and the fields only. The message of 1062
 * holds the duplicate value, which can be a token hash, so no part of a
 * driver message is copied.
 */
export function toStorageError(model: ModelName, err: unknown): StorageError | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { errno?: number };
  switch (e.errno) {
    case DUP_ENTRY: {
      // "Duplicate entry '<value>' for key '<table>.<index>'": the key name is after the last dot.
      const key = /for key '([^']*)'$/.exec(e.message)?.[1]?.split(".").at(-1);
      if (key === "PRIMARY") return new StorageError("unique_violation", model, ["id"]);
      const fields = key === undefined ? null : fieldsFromUniqueIndex(model, key);
      return new StorageError("unique_violation", model, fields ?? []);
    }
    case DATA_TOO_LONG:
    case TRUNCATED_WRONG_VALUE:
    case IMPOSSIBLE_STRING_CONVERSION:
      return new StorageError("invalid_argument", model, fieldOf(model, e.message));
    default:
      return null;
  }
}
