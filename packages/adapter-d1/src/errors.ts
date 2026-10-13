import { type ModelName, StorageError } from "@authtempo/core";
import { fieldsFromColumns } from "@authtempo/core/sql";

const UNIQUE_RE = /UNIQUE constraint failed: ((?:\w+\.\w+)(?:, \w+\.\w+)*)/;

/** Maps a SQLite unique error from D1 to a StorageError, or null when it is another error. */
export function toStorageError(model: ModelName, err: unknown): StorageError | null {
  if (!(err instanceof Error)) return null;
  const m = UNIQUE_RE.exec(err.message);
  if (!m?.[1]) return null;
  const columns = m[1].split(", ").map((pair) => pair.split(".")[1] ?? "");
  return new StorageError("unique_violation", model, fieldsFromColumns(model, columns));
}
