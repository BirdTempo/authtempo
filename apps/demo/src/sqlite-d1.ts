/**
 * The D1 surface over the SQLite store of a Durable Object (plan 11b Task 8).
 * The sandbox runs the real createD1Adapter and createD1Limiter on it, so the
 * demo shows the product's own SQL, migrations, and undo log.
 */

type Row = Record<string, SqlStorageValue>;
type Value = SqlStorageValue;

interface Shim {
  sql: SqlStorage;
  transactionSync: <T>(fn: () => T) => T;
}

/** The changed rows of the statement that just ran, as SQLite counts them. */
function changes(sql: SqlStorage, cursor: SqlStorageCursor<Row>): number {
  // A read writes no row, and changes() still holds the count of the last write.
  if (cursor.rowsWritten === 0) return 0;
  // Deviation 2 of the plan: changes() is SQLite's own count of changed rows.
  // The cursor's rowsWritten is the billing count and can count index rows.
  const n = sql.exec("SELECT changes() AS n").one().n;
  return Number(n);
}

function check(values: unknown[]): Value[] {
  for (const v of values) {
    // SqlStorageValue holds no boolean and no undefined (workers-types
    // 5.20261007.1), so a wrong value fails here, at the bind, with its type.
    const ok =
      v === null || typeof v === "string" || typeof v === "number" || v instanceof ArrayBuffer;
    if (!ok) throw new TypeError(`D1_TYPE_ERROR: type '${typeof v}' is not supported`);
  }
  return values as Value[];
}

class Statement {
  constructor(
    private readonly shim: Shim,
    readonly query: string,
    private readonly values: Value[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.shim, this.query, check(values));
  }

  /** Runs the statement now and answers the D1 result. A batch calls it inside its transaction. */
  exec(): D1Result<Row> {
    const cursor = this.shim.sql.exec<Row>(this.query, ...this.values);
    const results = cursor.toArray();
    const n = changes(this.shim.sql, cursor);
    return {
      results,
      success: true,
      meta: {
        changes: n,
        duration: 0,
        size_after: this.shim.sql.databaseSize,
        rows_read: cursor.rowsRead,
        rows_written: cursor.rowsWritten,
        last_row_id: 0,
        changed_db: n > 0,
      },
    };
  }

  async run(): Promise<D1Result<Row>> {
    return this.exec();
  }

  async all(): Promise<D1Result<Row>> {
    return this.exec();
  }

  async first(column?: string): Promise<unknown> {
    const row = this.exec().results[0];
    if (row === undefined) return null;
    if (column === undefined) return row;
    if (!(column in row))
      throw new Error(`D1_COLUMN_NOTFOUND: column '${column}' is not in the row`);
    return row[column];
  }
}

/**
 * The D1 database of one sandbox store. The adapter calls prepare, bind, run,
 * all, first, and batch only. A batch runs inside transactionSync, so a throw
 * rolls back the whole batch, as D1 applies a batch as one unit.
 */
export function sqliteD1(sql: SqlStorage, transactionSync: <T>(fn: () => T) => T): D1Database {
  const shim: Shim = { sql, transactionSync };
  const db = {
    prepare: (query: string) => new Statement(shim, query),
    batch: async (statements: Statement[]) =>
      transactionSync(() => statements.map((s) => s.exec())),
  };
  // The adapter calls prepare, bind, run, all, first, and batch only (adapter.ts,
  // schema-version.ts, limiter.ts, read 2026-10-14). The conformance suites hold this subset.
  return db as unknown as D1Database;
}
