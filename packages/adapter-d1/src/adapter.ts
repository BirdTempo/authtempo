import type { ModelName, StorageAdapter } from "@tempo-auth/core";
import { StorageError } from "@tempo-auth/core";
import {
  assertModel,
  columnsOf,
  decodeRow,
  deleteStatement,
  insertStatement,
  SQLITE,
  type Statement,
  selectStatement,
  TABLES,
  undoCreateWhere,
  updateStatement,
} from "@tempo-auth/core/sql";
import { toStorageError } from "./errors.js";

type Row = Record<string, unknown>;

/**
 * An undo log entry reverses one write. D1 has no interactive transaction,
 * so a transaction runs its statements at once and reverses its own writes
 * on a throw. It is not isolated from other requests: another request can
 * read a row this transaction later reverses, and a rollback restores the
 * row this transaction saw, not a row another request changed in between.
 * The engine's guards are unique keys and conditional updates, not this log.
 */
interface Undo extends Statement {
  model: ModelName;
  /** The write this entry reverses. A failed entry reports it as `<model>:<op>`. */
  op: "create" | "update" | "delete";
}

interface Ctx {
  undo: Undo[] | null;
  /** The schema version check, run once per adapter. */
  ready: () => Promise<void>;
}

async function run(db: D1Database, s: Statement): Promise<D1Result<Row>> {
  return db
    .prepare(s.sql)
    .bind(...s.params)
    .run<Row>();
}

async function all(db: D1Database, s: Statement): Promise<Row[]> {
  const res = await db
    .prepare(s.sql)
    .bind(...s.params)
    .all<Row>();
  return res.results;
}

function restoreRowStatement(model: ModelName, row: Row): Statement {
  // Rebuild the full row from the raw columns: an UPDATE of every column by id.
  const cols = Object.keys(row).filter((c) => c !== "id");
  return {
    sql: `UPDATE ${TABLES[model]} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    params: [...cols.map((c) => row[c]), row.id],
  };
}

function reinsertRowStatement(model: ModelName, row: Row): Statement {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${TABLES[model]} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    params: cols.map((c) => row[c]),
  };
}

/**
 * Runs every undo entry in reverse. A failed entry does not stop the rest.
 * When every entry succeeds, rethrows the original error unchanged. When any
 * entry fails, throws one rollback_failed error with `{ original, failures }`
 * as its cause, so a broken rollback never looks like the original error
 * (for example a benign unique_violation race). The original is never changed.
 * `fields` names each undo entry that failed as `<model>:<op>`, so a log line
 * says what is left behind.
 * No db.batch here: a batch that fails midway applies nothing.
 */
async function rethrowAfterUndo(
  db: D1Database,
  entries: Undo[],
  original: unknown,
): Promise<never> {
  const failures: unknown[] = [];
  const fields: string[] = [];
  for (const u of [...entries].reverse()) {
    try {
      await run(db, u);
    } catch (f) {
      failures.push(f);
      fields.push(`${u.model}:${u.op}`);
    }
  }
  if (failures.length === 0) throw original;
  const model = original instanceof StorageError ? original.model : "meta";
  throw new StorageError("rollback_failed", model, fields, { cause: { original, failures } });
}

function adapterOn(db: D1Database, ctx: Ctx): StorageAdapter {
  const self: StorageAdapter = {
    async create(model, data) {
      await ctx.ready();
      assertModel(model);
      const s = insertStatement(SQLITE, model, data);
      try {
        await run(db, s);
      } catch (e) {
        throw toStorageError(model, e) ?? e;
      }
      if (ctx.undo) {
        // The undo deletes `undoCreateWhere(...)`: a user created unverified
        // only while it is still unverified, so an owner's claim inside this
        // open transaction keeps its row (plan 8 I-1, plan 9 Task 4).
        const u = deleteStatement(SQLITE, model, undoCreateWhere(model, data));
        if (!u) throw new Error("undoCreate: an eq filter always compiles");
        ctx.undo.push({ model, op: "create", ...u });
      }
      return structuredClone(data);
    },
    async findOne(model, where) {
      await ctx.ready();
      const s = selectStatement(SQLITE, model, where, { limit: 1 });
      if (!s) return null;
      const rows = await all(db, s);
      return rows[0] ? decodeRow(SQLITE, model, rows[0]) : null;
    },
    async findMany(model, where, opts) {
      await ctx.ready();
      const s = selectStatement(SQLITE, model, where, opts);
      if (!s) return [];
      return (await all(db, s)).map((r) => decodeRow(SQLITE, model, r));
    },
    async update(model, where, data) {
      await ctx.ready();
      const s = updateStatement(SQLITE, model, where, data);
      if (!s) return 0;
      if (!ctx.undo) {
        try {
          return (await run(db, s)).meta.changes;
        } catch (e) {
          throw toStorageError(model, e) ?? e;
        }
      }
      // The prior read and the write run in one batch, which D1 applies as one
      // unit. The prior set is then exactly the changed set, so a rollback
      // never overwrites a row that another request wrote in between.
      const sel = selectStatement(SQLITE, model, where);
      if (!sel) return 0;
      let results: D1Result<Row>[];
      try {
        results = await db.batch<Row>([
          db.prepare(sel.sql).bind(...sel.params),
          db.prepare(s.sql).bind(...s.params),
        ]);
      } catch (e) {
        throw toStorageError(model, e) ?? e;
      }
      for (const row of results[0]?.results ?? [])
        ctx.undo.push({ model, op: "update", ...restoreRowStatement(model, row) });
      return results[1]?.meta.changes ?? 0;
    },
    async delete(model, where) {
      await ctx.ready();
      const s = deleteStatement(SQLITE, model, where);
      if (!s) return 0;
      if (!ctx.undo) return (await run(db, s)).meta.changes;
      // RETURNING gives the exact rows this statement removed, in one statement.
      const returning = {
        sql: `${s.sql} RETURNING ${columnsOf(model).join(", ")}`,
        params: s.params,
      };
      const rows = await all(db, returning);
      for (const row of rows)
        ctx.undo.push({ model, op: "delete", ...reinsertRowStatement(model, row) });
      return rows.length;
    },
    async transaction(fn) {
      await ctx.ready();
      if (ctx.undo) {
        // A nested call shares the log. A throw reverses only its own entries.
        const log = ctx.undo;
        const mark = log.length;
        try {
          return await fn(self);
        } catch (e) {
          const own = log.splice(mark);
          return rethrowAfterUndo(db, own, e);
        }
      }
      const inner: Ctx = { undo: [], ready: ctx.ready };
      const tx = adapterOn(db, inner);
      try {
        return await fn(tx);
      } catch (e) {
        return rethrowAfterUndo(db, inner.undo ?? [], e);
      }
    },
  };
  return self;
}

export function createD1AdapterWith(db: D1Database, ready: () => Promise<void>): StorageAdapter {
  return adapterOn(db, { undo: null, ready });
}

export { StorageError };
