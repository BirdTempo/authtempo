import type { ModelName, Models } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "./port.js";
import { jsonBytes, LIST_BYTES_MAX, LIST_MAX, listChunks } from "./sql.js";

export { LIST_MAX, listChunks };

/**
 * D1 binds at most 100 parameters per query (D1 limits page updated 21
 * April 2026, read 2026-10-09 and again 2026-10-20). Fifty leaves room for
 * the other clauses. A statement with more fails on D1 alone.
 */
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

/**
 * `findMany` with an `in` list of up to 1000 values in one statement
 * (ruling 84 of plan 12d). D1 and SQLite bind the list as one JSON text,
 * and Postgres and MySQL bind one parameter per value. A list of more than
 * `LIST_MAX` values, or of more than `LIST_BYTES_MAX` bytes of JSON text,
 * runs in the chunks of `listChunks`. The result keeps no order, and a
 * duplicate value is read once. The caller's `where` carries no `in`.
 */
export async function findManyList<M extends ModelName, F extends keyof Models[M] & string>(
  storage: StorageAdapter,
  model: M,
  field: F,
  values: readonly unknown[],
  where: Where<M>[] = [],
): Promise<Models[M][]> {
  if (where.some((w) => w.op === "in"))
    throw new StorageError("invalid_argument", model, ["where"]);
  const out: Models[M][] = [];
  for (const chunk of listChunks([...new Set(values)]))
    out.push(...(await storage.findMany(model, [...where, { field, op: "in", value: chunk }])));
  return out;
}

/** The statements of `findManyList` and of the other list writes of `values`. */
export function listCalls(values: readonly unknown[]): number {
  return listChunks([...new Set(values)]).length;
}

/**
 * The rows of `createMany` in the chunks of the engine (ruling 84 of plan
 * 12d): at most `LIST_MAX` rows, and at most half of `LIST_BYTES_MAX` of
 * the JSON text of their values, a date as its text. A D1 or SQLite
 * statement of a chunk binds the values as one JSON list, a date as a
 * number of fewer bytes. The Better Auth tables add a key column to a row,
 * shorter than the row. So the bound list of a chunk stays under
 * `LIST_BYTES_MAX`, and each chunk is one statement on every store.
 */
export function rowChunks<T extends object>(rows: readonly T[]): T[][] {
  return listChunks(rows, LIST_BYTES_MAX / 2, (r) => jsonBytes(Object.values(r)));
}

/** Inserts `rows` by `createMany`, one call per chunk of `rowChunks`: one statement each. */
export async function insertRows<M extends ModelName>(
  storage: StorageAdapter,
  model: M,
  rows: readonly Models[M][],
): Promise<void> {
  for (const chunk of rowChunks(rows)) await storage.createMany(model, chunk);
}
