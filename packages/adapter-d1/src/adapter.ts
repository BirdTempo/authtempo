import type { ModelName, StorageAdapter } from "@tempo-auth/core";
import { StorageError } from "@tempo-auth/core";
import {
  assertModel,
  decodeRow,
  deleteStatement,
  insertStatement,
  SQLITE,
  type Statement,
  selectStatement,
  TABLES,
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
type Undo = Statement;

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
      ctx.undo?.push({
        sql: `DELETE FROM ${TABLES[model]} WHERE id = ?`,
        params: [(data as { id: string }).id],
      });
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
      let prior: Row[] = [];
      if (ctx.undo) {
        const sel = selectStatement(SQLITE, model, where);
        prior = sel ? await all(db, sel) : [];
      }
      let res: D1Result<Row>;
      try {
        res = await run(db, s);
      } catch (e) {
        throw toStorageError(model, e) ?? e;
      }
      for (const row of prior) ctx.undo?.push(restoreRowStatement(model, row));
      return res.meta.changes;
    },
    async delete(model, where) {
      await ctx.ready();
      const s = deleteStatement(SQLITE, model, where);
      if (!s) return 0;
      let prior: Row[] = [];
      if (ctx.undo) {
        const sel = selectStatement(SQLITE, model, where);
        prior = sel ? await all(db, sel) : [];
      }
      const res = await run(db, s);
      for (const row of prior) ctx.undo?.push(reinsertRowStatement(model, row));
      return res.meta.changes;
    },
    async transaction(fn) {
      await ctx.ready();
      if (ctx.undo) return fn(self);
      const inner: Ctx = { undo: [], ready: ctx.ready };
      const tx = adapterOn(db, inner);
      try {
        return await fn(tx);
      } catch (e) {
        for (const u of [...(inner.undo ?? [])].reverse()) await run(db, u);
        throw e;
      }
    },
  };
  return self;
}

export function createD1AdapterWith(db: D1Database, ready: () => Promise<void>): StorageAdapter {
  return adapterOn(db, { undo: null, ready });
}

export { StorageError };
