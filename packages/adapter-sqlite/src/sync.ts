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
 * The count of changed rows of one statement is the growth of
 * `total_changes()`. One count works for a write, a write with RETURNING, and
 * a read on each driver. No core table has a trigger, so the count is the
 * statement's own.
 */
function step(h: SyncHandle, sql: string, values: readonly unknown[]): D1SubsetResult {
  const before = changesSoFar(h);
  // A driver row can have a null prototype (node:sqlite). The seam answers plain objects.
  const results = h.all(sql, values).map((r) => ({ ...r }));
  return { results, meta: { changes: changesSoFar(h) - before } };
}

function changesSoFar(h: SyncHandle): number {
  return Number(h.all("SELECT total_changes() AS n", [])[0]?.n ?? 0);
}

/**
 * Runs `fn` in one BEGIN IMMEDIATE transaction, in one synchronous block, so
 * no other call of this process runs inside it. A throw rolls back and passes
 * through.
 */
function inTransaction<T>(h: SyncHandle, fn: () => T): T {
  h.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn();
  } catch (e) {
    try {
      h.exec("ROLLBACK");
    } catch {
      // SQLite already ended the transaction for some errors. The first error is the one to report.
    }
    throw e;
  }
  h.exec("COMMIT");
  return result;
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
