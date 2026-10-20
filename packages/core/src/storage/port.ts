import type { ModelName, Models } from "../schema.js";

export type Op = "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte" | "startsWith";

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
  /**
   * A list sorts by each key in order. Lists that a person reads must end
   * with `id`, because the port has no tie-break and collation differs by dialect.
   */
  sort?: Sort<M> | Sort<M>[];
  limit?: number;
}

export type StorageErrorCode =
  | "unique_violation"
  | "unknown_model"
  | "unknown_field"
  | "invalid_argument"
  | "schema_mismatch"
  /**
   * Thrown when a D1 rollback could not reverse every write. `cause` holds
   * `{ original, failures }`: the error that started the rollback and the
   * errors of the undo entries that failed.
   */
  | "rollback_failed";

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    readonly model: string,
    readonly fields: readonly string[] = [],
    options?: { cause?: unknown },
  ) {
    super(`${code} on ${model}${fields.length ? ` (${fields.join(", ")})` : ""}`, options);
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
 * - An empty `in` list matches nothing. SQL rejects `IN ()`, so an adapter
 *   must answer it without sending that SQL.
 * - A unique key with null in any of its fields never conflicts, so two rows
 *   may both hold null there.
 *
 * Prefix rule (plan 12f). `startsWith` takes a non-empty string. It matches a
 * string field whose value begins with exactly that text, with case, and with
 * no wildcard. It never matches null. A value that is not a non-empty string
 * throws `invalid_argument`. It applies to `string` fields only; another field
 * type throws `invalid_argument`. A prefix with a lone surrogate or with NUL
 * throws `invalid_argument`. The SQL adapters compare a `substr` of the
 * column, so no index serves it: each call scans the table.
 *
 * Sort rules. Nulls come last in ascending order and first in descending order.
 *
 * Write rules. `create` fails with `unique_violation` on ["id"] if the id
 * exists. `update` is all or nothing: if any new row breaks a unique key, no
 * row changes. `update` data must not hold `id`; that is `unknown_field`.
 * An unknown model is `unknown_model` on every method, and an unknown field
 * in data, where, or sort is `unknown_field`.
 *
 * Argument rules. `update` and `delete` with an empty `where` throw
 * `invalid_argument`, so a bug cannot change or remove every row. A `limit`
 * that is not a non-negative integer throws `invalid_argument`. A `limit` of
 * 0 returns an empty list. `schema_mismatch` means the database reports a
 * schema version older than `SCHEMA_VERSION`, or no version at all. Run the
 * adapter's migrations.
 *
 * Transaction rules. Reads inside a transaction see its own writes; the
 * engine relies on this. If the function throws, only the transaction's own
 * writes are reversed. Rows that other callers wrote in the meantime stay.
 * Two concurrent transactions that read and then create the same unique
 * value leave one row. The loser may fail with `unique_violation`.
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
    data: Partial<Omit<Models[M], "id">>,
  ): Promise<number>;
  delete<M extends ModelName>(model: M, where: Where<M>[]): Promise<number>;
  transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
  /**
   * Optional. The count of statements that this adapter sent to its
   * database since its creation, its transactions included (ruling 35 of
   * plan 12f). D1 counts each statement, and each statement of a batch:
   * D1 Free allows 50 queries per invocation. Memory and Postgres count
   * their port calls. A caller reads it twice and takes the difference, so
   * a count of a shared adapter can only be too high, never too low.
   */
  statementsSent?(): number;
}
