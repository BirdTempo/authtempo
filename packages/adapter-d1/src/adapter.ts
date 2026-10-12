import type { ModelName, StorageAdapter } from "@tempo-auth/core";
import { StorageError } from "@tempo-auth/core";
import { assertModel, type SqlStatements, type Statement } from "@tempo-auth/core/sql";

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

/** What the adapter runs. `createD1Adapter` passes core's statements; plan 9's compatibility storage passes its own. */
export interface D1AdapterOptions {
  statements: SqlStatements;
  toStorageError(model: ModelName, err: unknown): StorageError | null;
  /** The schema version check, run once per adapter. */
  ready(): Promise<void>;
}

interface Ctx extends D1AdapterOptions {
  undo: Undo[] | null;
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
  const st = ctx.statements;
  const self: StorageAdapter = {
    async create(model, data) {
      await ctx.ready();
      assertModel(model);
      const s = st.insert(model, data);
      try {
        await run(db, s);
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
      if (ctx.undo) {
        // The undo of a user create deletes the row only while no row of
        // `USER_CHILD_MODELS` names it. An unverified create is also deleted
        // only while `emailVerified` is false. Another request can claim the
        // user or add a child row inside this open transaction, and the undo
        // must keep that user (plan 9 Task 4, plan 8b). The rule lives in
        // `whileNoChildRow` in core's `sql.ts`.
        ctx.undo.push({ model, op: "create", ...st.undoCreate(model, data) });
      }
      return structuredClone(data);
    },
    async findOne(model, where) {
      await ctx.ready();
      const s = st.select(model, where, { limit: 1 });
      if (!s) return null;
      const rows = await all(db, s);
      return rows[0] ? st.decode(model, rows[0]) : null;
    },
    async findMany(model, where, opts) {
      await ctx.ready();
      const s = st.select(model, where, opts);
      if (!s) return [];
      return (await all(db, s)).map((r) => st.decode(model, r));
    },
    async update(model, where, data) {
      await ctx.ready();
      const s = st.update(model, where, data);
      if (!s) return 0;
      if (!ctx.undo) {
        try {
          return (await run(db, s)).meta.changes;
        } catch (e) {
          throw ctx.toStorageError(model, e) ?? e;
        }
      }
      // The prior read and the write run in one batch, which D1 applies as one
      // unit. The prior set is then exactly the changed set, so a rollback
      // never overwrites a row that another request wrote in between.
      const sel = st.undoSelect(model, where);
      if (!sel) return 0;
      let results: D1Result<Row>[];
      try {
        results = await db.batch<Row>([
          db.prepare(sel.sql).bind(...sel.params),
          db.prepare(s.sql).bind(...s.params),
        ]);
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
      for (const row of results[0]?.results ?? [])
        ctx.undo.push({ model, op: "update", ...st.restoreRow(model, row, data) });
      return results[1]?.meta.changes ?? 0;
    },
    async delete(model, where) {
      await ctx.ready();
      if (!ctx.undo) {
        const s = st.delete(model, where);
        if (!s) return 0;
        return (await run(db, s)).meta.changes;
      }
      // A foreign key's ON DELETE CASCADE deletes child rows inside SQLite.
      // RETURNING lists only this table's rows, so the log holds no entry for
      // the children, and a rollback restores the parent without them. Core's
      // own tables have no foreign key; the Better Auth tables have seven
      // (plan 9). Inside `transaction`, delete the child rows first, as core's
      // deleteOrganization does (plan 9b2, spec 17.8).
      // RETURNING gives the exact rows this statement removed, in one statement.
      // An impossible where (an empty `in`) answers null here as in `delete`.
      const returning = st.deleteReturning(model, where);
      if (!returning) return 0;
      const rows = await all(db, returning);
      for (const row of rows) ctx.undo.push({ model, op: "delete", ...st.reinsertRow(model, row) });
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
      const inner: Ctx = { ...ctx, undo: [] };
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

export function createD1AdapterOn(db: D1Database, options: D1AdapterOptions): StorageAdapter {
  return adapterOn(db, { ...options, undo: null });
}

export { StorageError };
