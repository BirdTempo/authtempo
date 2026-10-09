import type { ModelName, Models } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "./port.js";

/** D1 binds at most 100 parameters per statement (read 2026-10-09); fifty leaves room for the other clauses. */
export const IN_CHUNK = 50;

/**
 * `findMany` with an `in` list of any length. The list runs in chunks, and
 * the result keeps no order: sort it after. A duplicate value is read once.
 *
 * The caller's `where` carries no `in` and at most 50 parameters, so one
 * statement binds at most 100. A caller `in` throws, because its length is
 * not bounded by the chunk.
 */
export async function findManyIn<M extends ModelName, F extends keyof Models[M] & string>(
  storage: StorageAdapter,
  model: M,
  field: F,
  values: readonly unknown[],
  where: Where<M>[] = [],
): Promise<Models[M][]> {
  if (where.some((w) => w.op === "in"))
    throw new StorageError("invalid_argument", model, ["where"]);
  const unique = [...new Set(values)];
  const out: Models[M][] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    out.push(...(await storage.findMany(model, [...where, { field, op: "in", value: chunk }])));
  }
  return out;
}
