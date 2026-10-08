import type { ModelName, Models } from "../schema.js";

export type Op = "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte";

export interface Where<M extends ModelName> {
  field: keyof Models[M] & string;
  op: Op;
  value: unknown;
}

export interface Sort<M extends ModelName> {
  field: keyof Models[M] & string;
  dir: "asc" | "desc";
}

export interface FindManyOptions<M extends ModelName> {
  sort?: Sort<M>;
  limit?: number;
}

export type StorageErrorCode = "unique_violation" | "unknown_model" | "unknown_field";

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    readonly model: string,
    readonly fields: readonly string[] = [],
  ) {
    super(`${code} on ${model}${fields.length ? ` (${fields.join(", ")})` : ""}`);
    this.name = "StorageError";
  }
}

/**
 * The storage port. Clauses join with AND. There is no OR and no join. When
 * the engine needs two tables it does two reads. `update` and `delete` take
 * a `where`, never a bare id, so "consume if not consumed" is one statement.
 *
 * Null rules. They match SQL, and every adapter must follow them:
 * - `eq null` means IS NULL. `ne null` means IS NOT NULL.
 * - `ne x` with a non-null x does not match a row where the field is null.
 * - `in` never matches a row where the field is null, even if the list holds null.
 * - `lt`, `lte`, `gt` and `gte` are false when the field is null.
 *
 * Sort rules. Nulls come last in ascending order and first in descending order.
 *
 * Write rules. `create` fails with `unique_violation` on ["id"] if the id
 * exists. `update` is all or nothing: if any new row breaks a unique key, no
 * row changes. `update` data must not hold `id`; that is `unknown_field`.
 * An unknown model is `unknown_model` on every method, and an unknown field
 * in data, where, or sort is `unknown_field`.
 */
export interface StorageAdapter {
  create<M extends ModelName>(model: M, data: Models[M]): Promise<Models[M]>;
  findOne<M extends ModelName>(model: M, where: Where<M>[]): Promise<Models[M] | null>;
  findMany<M extends ModelName>(
    model: M,
    where: Where<M>[],
    opts?: FindManyOptions<M>,
  ): Promise<Models[M][]>;
  update<M extends ModelName>(
    model: M,
    where: Where<M>[],
    data: Partial<Models[M]>,
  ): Promise<number>;
  delete<M extends ModelName>(model: M, where: Where<M>[]): Promise<number>;
  transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
}
