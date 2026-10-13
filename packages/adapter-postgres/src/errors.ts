import { type ModelName, StorageError } from "@authtempo/core";
import { fieldsFromUniqueIndex } from "@authtempo/core/sql";

/** Maps a Postgres 23505 error to a StorageError by its constraint name, or null for any other error. */
export function toStorageError(model: ModelName, err: unknown): StorageError | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { code?: string; constraint_name?: string };
  if (e.code !== "23505") return null;
  const fields = e.constraint_name ? fieldsFromUniqueIndex(model, e.constraint_name) : null;
  return new StorageError("unique_violation", model, fields ?? []);
}
