/**
 * The part of a postgres.js client that this package calls: the seam to the
 * driver. The peer range of `postgres` is `^3.4.9 || ^4.1.1`, and the `Sql`
 * types of the two majors do not fit each other. A public type that names
 * `Sql` ties each app to the major that this package compiled against. These
 * types name the calls only, so the client of each major fits them. The
 * typecheck of the repo proves both: the CLI passes a client of 3.4.9, and
 * examples/worker-postgres passes a client of 4.1.1.
 */

/** The rows of one statement, with the count of the rows that the statement read or changed. */
export type PostgresRows<Row = Record<string, unknown>> = readonly Row[] & {
  readonly count: number;
};

/** A value that this package binds to a statement. Each major of postgres.js takes each of these. */
export type PostgresParameter = string | number | boolean | null | Date | Uint8Array;

/** A connection that runs one statement: the client, a transaction, or a savepoint. */
export interface PostgresConnection {
  unsafe<Row = Record<string, unknown>>(
    query: string,
    parameters?: PostgresParameter[],
  ): PromiseLike<PostgresRows<Row>>;
}

/** An open transaction of `begin`, or a savepoint in it. */
export interface PostgresTransaction extends PostgresConnection {
  savepoint<T>(fn: (sp: PostgresTransaction) => Promise<T>): Promise<unknown>;
}

/** A postgres.js client: what `postgres(url, options)` returns. */
export interface PostgresClient extends PostgresConnection {
  begin<T>(fn: (tx: PostgresTransaction) => Promise<T>): Promise<unknown>;
}
