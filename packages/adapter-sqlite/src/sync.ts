import type { D1Subset, D1SubsetResult, D1SubsetStatement } from "@authtempo/adapter-d1/seam";
import type { Statement } from "@authtempo/core/sql";
import type { SqliteDriver } from "./adapter.js";

type Row = Record<string, unknown>;

/** What a synchronous driver gives the seam. Each entry adapts its handle to it (plan 12g). */
export interface SyncHandle {
  readonly name: "node:sqlite" | "better-sqlite3" | "bun:sqlite";
  /** Runs one statement of any kind and answers its rows, or none. */
  all(sql: string, values: readonly unknown[]): Row[];
  /** Runs one or more statements with no values. */
  exec(script: string): void;
}

/**
 * The count of changed rows of one statement, as D1 gives it. `changes()`
 * counts only the rows of the statement itself, not the rows of a trigger or
 * of an ON DELETE CASCADE. But `changes()` keeps the count of the last write
 * after a read. So the step reads it only when `total_changes()` grew, and
 * answers 0 for a read or a write that changed no row.
 */
function step(h: SyncHandle, sql: string, values: readonly unknown[]): D1SubsetResult {
  const before = Number(h.all("SELECT total_changes() AS t", [])[0]?.t ?? 0);
  // A driver row can have a null prototype (node:sqlite). The seam answers plain objects.
  const results = h.all(sql, values).map((r) => ({ ...r }));
  const after = h.all("SELECT total_changes() AS t, changes() AS c", [])[0];
  const changes = Number(after?.t ?? 0) > before ? Number(after?.c ?? 0) : 0;
  return { results, meta: { changes } };
}

/**
 * Runs `fn` in one BEGIN IMMEDIATE transaction, in one synchronous block, so
 * no other call of this process runs inside it. A throw rolls back and passes
 * through. COMMIT is inside the try: a COMMIT can fail with SQLITE_BUSY while
 * another connection holds a read lock. SQLite then keeps the transaction
 * open, and without the ROLLBACK each later write of the handle stays in it.
 */
function inTransaction<T>(h: SyncHandle, fn: () => T): T {
  h.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    h.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      h.exec("ROLLBACK");
    } catch {
      // SQLite already ended the transaction for some errors. The first error is the one to report.
    }
    throw e;
  }
}

class SyncStatement implements D1SubsetStatement {
  constructor(
    private readonly h: SyncHandle,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SyncStatement {
    return new SyncStatement(this.h, this.sql, values);
  }

  async run(): Promise<D1SubsetResult> {
    return { results: [], meta: { changes: step(this.h, this.sql, this.values).meta.changes } };
  }

  async all(): Promise<D1SubsetResult> {
    return step(this.h, this.sql, this.values);
  }

  async first(column?: string): Promise<unknown> {
    // D1 answers null for no row (plan 12g, deviation 7).
    const row = step(this.h, this.sql, this.values).results[0];
    if (row === undefined) return null;
    return column === undefined ? row : (row[column] ?? null);
  }
}

/** Builds the seam and the runner step over a synchronous handle. */
export function syncDriver(h: SyncHandle): SqliteDriver {
  const db: D1Subset = {
    prepare: (sql) => new SyncStatement(h, sql),
    async batch(statements) {
      return inTransaction(h, () =>
        statements.map((s) => {
          if (!(s instanceof SyncStatement))
            throw new TypeError("batch takes statements of this database");
          return step(h, s.sql, s.values);
        }),
      );
    },
  };
  return {
    name: h.name,
    db,
    async migrateStep(done: Statement, script: string, record: Statement) {
      return inTransaction(h, () => {
        if (h.all(done.sql, done.params).length > 0) return false;
        h.exec(script);
        h.all(record.sql, record.params);
        return true;
      });
    },
    async sqliteVersion() {
      return String(h.all("SELECT sqlite_version() AS v", [])[0]?.v);
    },
  };
}
