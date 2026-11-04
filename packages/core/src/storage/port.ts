import type { STORAGE_ERROR_CODES } from "../errors.js";
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
  /**
   * True: the field is not nullable in the schema. So the SQL has no
   * `IS NULL` term, and an index on the column gives the order (ruling 27
   * of plan 12i). A nullable field with it is `invalid_argument`.
   */
  notNull?: true;
}

export interface FindManyOptions<M extends ModelName> {
  /**
   * A list sorts by each key in order. Lists that a person reads must end
   * with `id`, because the port has no tie-break and collation differs by dialect.
   */
  sort?: Sort<M> | Sort<M>[];
  limit?: number;
}

// The codes of `StorageError` live in ../errors.ts (plan 12g fix wave, M1).
// That file imports nothing, so the demo browser copy of core/errors.js
// pulls in no storage file.
export { STORAGE_ERROR_CODES } from "../errors.js";

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

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
 * column, so no index serves it: each call scans the table. A string with NUL
 * or with a lone surrogate in any where value throws `invalid_argument` too,
 * on every op and on every store, also in an `in` list.
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
 * Many-row rule (ruling 57 of plan 12d). `createMany` writes its rows in
 * chunks of `rowsPerInsert(model)`, one INSERT statement per chunk, so
 * `statementsSent` grows by ceil(n / chunk), or more on a split below.
 * An empty list sends nothing and answers []. It is all or nothing,
 * inside a transaction and outside one: when a row breaks a unique key,
 * with a stored row or with another row of the list, the call fails with
 * `unique_violation` and writes no row. Each row meets the rules of
 * `create` data. On D1 and SQLite the rows of a chunk bind as one JSON
 * list, and a statement of more than 100 KB splits in halves (ruling 84 of
 * plan 12d). The halves stop at one row. So one value of more than 90 KB,
 * or one row of more than 100 KB, goes alone in its statement. D1 may
 * refuse such a statement; then the whole call fails, all or nothing
 * (ruling 85). A string with a lone surrogate stores U+FFFD in its place,
 * by `create` and by `createMany` alike. On MySQL a chunk of more than 50
 * rows takes one of the sizes 64, 128, 256, 512, and 1000. So the server
 * keeps few prepared statements (ruling 85).
 *
 * List rule (rulings 84 and 85 of plan 12d). An `in` list of up to 2000 values
 * is one statement on every store. On D1 and SQLite a list of more than 50
 * values binds as one JSON text, so the bound parameters do not grow. On MySQL
 * such a list pads to the next of the sizes 64, 128, 256, 512, 1000, and 2000.
 * The pad repeats its last value, which matches no other row. The values stay
 * bound, and none enters the SQL text.
 *
 * Transaction rules. Reads inside a transaction see its own writes; the
 * engine relies on this. If the function throws, only the transaction's own
 * writes are reversed. Rows that other callers wrote in the meantime stay.
 * Two concurrent transactions that read and then create the same unique
 * value leave one row. The loser may fail with `unique_violation`.
 *
 * Update 2026-11-04 by plan 12o: `keep` makes the writes so far final, so a
 * later throw reverses only the later writes. That holds on a store with no
 * isolation (D1, SQLite) and on memory. On Postgres and MySQL it does
 * nothing, and a throw still reverses the whole transaction.
 */
export interface StorageAdapter {
  create<M extends ModelName>(model: M, data: Models[M]): Promise<Models[M]>;
  /** Inserts `rows` of one model by the many-row rule above. */
  createMany<M extends ModelName>(model: M, rows: readonly Models[M][]): Promise<Models[M][]>;
  /**
   * The most rows of `model` that one statement of `createMany` writes: the
   * bound-parameter limit of the database over the parameters of one row,
   * and at most 1000 (`INSERT_ROWS_MAX` of sql.ts).
   * The engine reads it for the worst case of its call budget.
   */
  rowsPerInsert(model: ModelName): number;
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
  /**
   * Deletes the rows that `where` matches and answers them, in the shape of
   * `findMany` (plan 12o). A row that another caller removed first is not
   * in the answer, so the answer is the rows that this call removed. It
   * keeps the argument rules of `delete`. D1, SQLite, and Postgres run one
   * `DELETE … RETURNING`. MySQL has no RETURNING: it reads the ids, reads
   * the rows under their locks by id, and deletes them by id, in one
   * transaction. So no other caller removes a row between the read and the
   * delete. Inside a transaction a throw puts the rows back, as for `delete`.
   */
  deleteRows<M extends ModelName>(model: M, where: Where<M>[]): Promise<Models[M][]>;
  /**
   * Makes the writes of the open transaction so far final (plan 12o): a
   * later throw reverses only the writes after this call. Inside a nested
   * transaction, it makes final only the writes of that nested call.
   * Answers true when a later throw keeps those writes. That holds on D1,
   * on SQLite, on memory, and outside a transaction, where no write is
   * reversed. On Postgres and MySQL it does nothing and answers false. There
   * the open transaction is isolated, and a parallel writer of the same
   * row waits for its row lock. So a throw still reverses the whole
   * transaction, and no other caller saw its writes. A claim calls it after
   * its last write, so a throw after the claim keeps the claim (spec 8.9).
   */
  keep(): Promise<boolean>;
  transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
  /**
   * Optional. The count of statements that this adapter sent to its
   * database since its creation, its transactions included (ruling 35 of
   * plan 12f). D1 counts each statement, and each statement of a batch:
   * D1 Free allows 50 queries per invocation. The queries of the D1 ready
   * check count too, in core's adapter and in the D1 storage of the Better
   * Auth tables (ruling 37). Memory and Postgres count their port calls.
   * A caller reads it twice and takes the difference, so a count of a
   * shared adapter can only be too high, never too low. The conformance kit
   * checks the count of each port call, inside a transaction too.
   */
  statementsSent?(): number;
  /**
   * Optional. True when the database caps the queries of one invocation.
   * D1 allows 50 queries per invocation on Workers Free (D1 limits page
   * updated 21 April 2026, read 2026-10-21). Only on such a store does an
   * account delete refuse with `delete_too_large` when its least work
   * cannot fit 50. This holds for the self delete and the operator delete
   * (rulings 5 and 10 of plan 12f2). The flag also keeps the page of the own
   * sessions of an account delete inside the call budget. With no flag, the
   * page ends up to 500 of the user's own sessions in one act.
   * Postgres, MySQL, SQLite, and memory have no such cap and leave it out.
   */
  queryLimitPerInvocation?: boolean;
  /**
   * Optional. True when a delete of a user row also deletes, by a foreign
   * key, the rows that name the user: the sessions, the accounts, the
   * member rows, and the invitations that the user sent. The Better Auth
   * tables do this, and so does an organization delete for its member
   * rows (ruling 13 of plan 12f2). The account delete then runs every
   * check that can refuse, and the pages of the sessions, before the user
   * delete. Else a refusal came after rows that no undo could restore on
   * D1, and the session hooks saw no session. Core's tables have no
   * foreign key and leave it out: there the user row goes first, because
   * D1 has no lock (user-hold.ts).
   * Update 2026-11-04 by plan 12o: the cascade also takes the sessions past
   * the page, and no sweep can see them. So with the impersonation tool on,
   * the delete first reads the user's live impersonation sessions, at most
   * 100. More answer `delete_too_large`. The pending-end row names those
   * that the page does not end, and the sweep writes their stop rows.
   */
  userDeleteCascades?: boolean;
  /**
   * Optional. Inside a transaction, takes the row locks of the rows that
   * `where` matches, by `id` ascending (ruling 36 of plan 12f). The caller
   * then writes them. One DELETE locks rows in the order of its scan. So
   * two flows that delete the same rows in one statement each can wait on
   * each other. Postgres runs SELECT ... ORDER BY id FOR UPDATE. D1
   * and memory have no row lock and leave it out. It costs one statement.
   * Update 2026-10-21 by plan 12g: InnoDB locks rows in the order of the
   * index that it reads, not in the ORDER BY order. So the MySQL adapter
   * reads the ids first and then locks them by id: two statements. The
   * conformance option `lockStatements` holds that count.
   * An adapter on a database with row locks must have it (ruling 37):
   * without it the session deletes of two flows can deadlock. The
   * conformance kit checks it with the option `rowLocks: true`.
   */
  lockInOrder?<M extends ModelName>(model: M, where: Where<M>[]): Promise<void>;
  /**
   * Optional. Runs the ready check of the adapter, such as its schema
   * version check, when it has not run. It answers the count of statements
   * that the check sent in the life of the adapter (ruling 37 of plan 12f).
   * The operator session calls reserve it in their call budget. A core D1
   * adapter answers 1. The D1 storage of the Better Auth tables answers 4
   * or more: its check also reads the indexes of the account table. An
   * adapter that leaves it out counts as 1.
   */
  readyStatements?(): Promise<number>;
  /**
   * Optional. Reads the stored schema version with no cache, each call, and
   * throws `schema_mismatch` for an old one (plan 12h Task 8, spec 31 item
   * 12). `GET /ready` calls it. It never sets or reads the cached check of
   * the adapter, so `readyStatements` stays the same. Its statements count
   * in `statementsSent`. An adapter with no `ping` gets one read of a user
   * row by an id that no row holds.
   */
  ping?(): Promise<void>;
}
