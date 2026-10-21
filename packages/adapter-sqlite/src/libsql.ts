import type { D1Subset, D1SubsetResult, D1SubsetStatement } from "@authtempo/adapter-d1/seam";
import type { Statement } from "@authtempo/core/sql";
import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";
import type { SqliteDriver } from "./adapter.js";

/**
 * How long `migrateStep` waits for the write lock of a local file. A libSQL
 * file client gets SQLITE_BUSY at once when another connection holds the
 * lock, and its `timeout` option blocks the thread (read 2026-10-21, 0.18.0).
 * So the step tries again after a short pause.
 */
const BUSY_WAIT_MS = 10_000;
const BUSY_PAUSE_MS = 20;

function plainRows(rs: ResultSet): Record<string, unknown>[] {
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
}

function result(rs: ResultSet): D1SubsetResult {
  return { results: plainRows(rs), meta: { changes: rs.rowsAffected } };
}

class LibsqlStatement implements D1SubsetStatement {
  constructor(
    private readonly client: Client,
    readonly sql: string,
    readonly args: InValue[] = [],
  ) {}

  bind(...values: unknown[]): LibsqlStatement {
    return new LibsqlStatement(this.client, this.sql, values as InValue[]);
  }

  async run(): Promise<D1SubsetResult> {
    const rs = await this.client.execute({ sql: this.sql, args: this.args });
    return { results: [], meta: { changes: rs.rowsAffected } };
  }

  async all(): Promise<D1SubsetResult> {
    return result(await this.client.execute({ sql: this.sql, args: this.args }));
  }

  async first(column?: string): Promise<unknown> {
    // D1 answers null for no row (plan 12g, deviation 7).
    const row = (await this.all()).results[0];
    if (row === undefined) return null;
    return column === undefined ? row : (row[column] ?? null);
  }
}

function isBusy(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "SQLITE_BUSY";
}

async function writeTransaction(client: Client): Promise<Transaction> {
  const deadline = Date.now() + BUSY_WAIT_MS;
  for (;;) {
    try {
      return await client.transaction("write");
    } catch (e) {
      if (!isBusy(e) || Date.now() > deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, BUSY_PAUSE_MS));
    }
  }
}

/**
 * A SqliteDriver over a libSQL client that the app opened: a `file:` URL on
 * Node or Bun, or `https:` and `libsql:` through `@libsql/client/web` on
 * Workers. Open it without `intMode: "bigint"`: the adapter refuses it.
 */
export function libsql(client: Client): SqliteDriver {
  const db: D1Subset = {
    prepare: (sql) => new LibsqlStatement(client, sql),
    async batch(statements) {
      const list = statements.map((s) => {
        if (!(s instanceof LibsqlStatement))
          throw new TypeError("batch takes statements of this database");
        return { sql: s.sql, args: s.args };
      });
      // One implicit transaction under BEGIN IMMEDIATE; a failure rolls back the whole batch.
      return (await client.batch(list, "write")).map(result);
    },
  };
  return {
    name: "libsql",
    db,
    async migrateStep(done: Statement, script: string, record: Statement) {
      // The adapter opens no interactive transaction. The runner needs "run this
      // file only when ta_migrations lacks its name" in one unit, which a batch
      // cannot express (plan 12g, deviation 11).
      const tx = await writeTransaction(client);
      try {
        const found = await tx.execute({ sql: done.sql, args: done.params as InValue[] });
        if (found.rows.length > 0) {
          await tx.rollback();
          return false;
        }
        await tx.executeMultiple(script);
        await tx.execute({ sql: record.sql, args: record.params as InValue[] });
        await tx.commit();
        return true;
      } catch (e) {
        await tx.rollback().catch(() => {
          // The first error is the one to report.
        });
        throw e;
      } finally {
        tx.close();
      }
    },
    async sqliteVersion() {
      const rs = await client.execute("SELECT sqlite_version() AS v");
      return String(rs.rows[0]?.v);
    },
  };
}
