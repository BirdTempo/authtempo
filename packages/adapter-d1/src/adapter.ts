import type { ModelName, StorageAdapter } from "@authtempo/core";
import { StorageError } from "@authtempo/core";
import {
  assertModel,
  D1_BOUND_PARAMS,
  insertChunks,
  rowsPerInsertOf,
  type SqlStatements,
  type Statement,
  undoCreateMany,
} from "@authtempo/core/sql";
import type { D1Subset, D1SubsetResult } from "./seam.js";

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
  /**
   * The undo of `createMany` calls of one model, one after the other in the
   * log. It holds their rows and the count of the entries that delete them.
   * Each entry of the run holds the same object (ruling 85 of plan 12d).
   */
  many?: { rows: readonly Row[]; entries: number };
}

/** What the adapter runs. `createD1Adapter` passes core's statements; plan 9's compatibility storage passes its own. */
export interface D1AdapterOptions {
  statements: SqlStatements;
  toStorageError(model: ModelName, err: unknown): StorageError | null;
  /** The schema version check, run once per adapter. */
  ready(): Promise<void>;
  /**
   * The check of `ready` with no cache, each call: the adapter's `ping`
   * (plan 12h Task 8). It counts its own queries in `sent`. Leave it out,
   * and the adapter has no `ping`.
   */
  ping?(): Promise<void>;
  /**
   * The count of `statementsSent`, shared with each transaction (ruling 35
   * of plan 12f). Pass the same object to the schema check, so its queries
   * count too. With `ready`, the check also counts its own queries there,
   * and the adapter answers it as `readyStatements` (ruling 37). Default: a
   * new count with no `ready`.
   */
  sent?: { statements: number; ready?: number };
  /**
   * The bound parameters of one statement, for the chunks of `createMany`
   * (ruling 57 of plan 12d). Default: `D1_BOUND_PARAMS`, 100. A SQLite
   * driver passes the limit of its own build. A statement set whose rows
   * bind as one JSON list (ruling 84) does not read it.
   */
  boundParams?: number;
  /**
   * True on a D1 binding: D1 Free allows 50 queries per invocation, so the
   * operator delete refuses a delete that cannot fit them (ruling 5 of plan
   * 12f2). The SQLite adapter runs this code over a local database with no
   * such limit, and leaves it out.
   */
  queryLimitPerInvocation?: boolean;
}

interface Ctx extends D1AdapterOptions {
  undo: Undo[] | null;
  sent: { statements: number; ready?: number };
  /** The first entry of the log that the open nested transaction owns: a run of `many` never joins an entry below it. */
  floor: number;
}

async function run(db: D1Subset, s: Statement, sent: Ctx["sent"]): Promise<D1SubsetResult> {
  sent.statements++;
  return db
    .prepare(s.sql)
    .bind(...s.params)
    .run();
}

async function all(db: D1Subset, s: Statement, sent: Ctx["sent"]): Promise<Row[]> {
  sent.statements++;
  const res = await db
    .prepare(s.sql)
    .bind(...s.params)
    .all();
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
  db: D1Subset,
  entries: Undo[],
  original: unknown,
  sent: Ctx["sent"],
): Promise<never> {
  const failures: unknown[] = [];
  const fields: string[] = [];
  for (const u of [...entries].reverse()) {
    try {
      await run(db, u, sent);
    } catch (f) {
      failures.push(f);
      fields.push(`${u.model}:${u.op}`);
    }
  }
  if (failures.length === 0) throw original;
  const model = original instanceof StorageError ? original.model : "meta";
  throw new StorageError("rollback_failed", model, fields, { cause: { original, failures } });
}

function adapterOn(db: D1Subset, ctx: Ctx): StorageAdapter {
  const st = ctx.statements;
  const self: StorageAdapter = {
    async create(model, data) {
      await ctx.ready();
      assertModel(model);
      const s = st.insert(model, data);
      try {
        await run(db, s, ctx.sent);
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
    async createMany(model, rows) {
      await ctx.ready();
      assertModel(model);
      if (rows.length === 0) return [];
      const chunks = insertChunks(st, model, rows, ctx.boundParams ?? D1_BOUND_PARAMS);
      try {
        const [only] = chunks;
        if (chunks.length === 1 && only) await run(db, only, ctx.sent);
        else {
          // One batch is one unit on D1 and on each SQLite driver: a failed chunk
          // applies no chunk. A batch sends each of its statements.
          ctx.sent.statements += chunks.length;
          await db.batch(chunks.map((c) => db.prepare(c.sql).bind(...c.params)));
        }
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
      if (ctx.undo) {
        // The undo of a createMany right after a createMany of the same model joins its
        // run: one delete per list of all their ids. An insert of 1000 rows in four chunks
        // then takes one undo statement, not four. So the undo of a late conflict stays
        // inside the D1 budget (ruling 85 of plan 12d). Only an entry just before this one
        // joins, so the reverse order of the log does not change.
        const log = ctx.undo;
        const last = log.at(-1);
        let all: readonly Row[] = rows as unknown as Row[];
        if (last?.many && last.model === model && log.length - last.many.entries >= ctx.floor) {
          all = [...last.many.rows, ...all];
          log.splice(log.length - last.many.entries);
        }
        const undo = undoCreateMany(st, model, all as never);
        // A user row keeps one statement per row (undoCreate), so its run does not join.
        const many = model === "user" ? undefined : { rows: all, entries: undo.length };
        for (const u of undo) log.push({ model, op: "create", ...u, ...(many ? { many } : {}) });
      }
      return structuredClone([...rows]);
    },
    rowsPerInsert(model) {
      return rowsPerInsertOf(st, model, ctx.boundParams ?? D1_BOUND_PARAMS);
    },
    async findOne(model, where) {
      await ctx.ready();
      const s = st.select(model, where, { limit: 1 });
      if (!s) return null;
      const rows = await all(db, s, ctx.sent);
      return rows[0] ? st.decode(model, rows[0]) : null;
    },
    async findMany(model, where, opts) {
      await ctx.ready();
      const s = st.select(model, where, opts);
      if (!s) return [];
      return (await all(db, s, ctx.sent)).map((r) => st.decode(model, r));
    },
    async update(model, where, data) {
      await ctx.ready();
      const s = st.update(model, where, data);
      if (!s) return 0;
      if (!ctx.undo) {
        try {
          return (await run(db, s, ctx.sent)).meta.changes;
        } catch (e) {
          throw ctx.toStorageError(model, e) ?? e;
        }
      }
      // The prior read and the write run in one batch, which D1 applies as one
      // unit. The prior set is then exactly the changed set, so a rollback
      // never overwrites a row that another request wrote in between.
      const sel = st.undoSelect(model, where);
      if (!sel) return 0;
      let results: D1SubsetResult[];
      // A batch sends each of its statements.
      ctx.sent.statements += 2;
      try {
        results = await db.batch([
          db.prepare(sel.sql).bind(...sel.params),
          db.prepare(s.sql).bind(...s.params),
        ]);
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
      // The list form for more than one row when the statement set has one: the undo of an
      // update of many rows stays inside the query budget (ruling 84 of plan 12d).
      const prior = results[0]?.results ?? [];
      const restores =
        prior.length > 1 && st.restoreRows
          ? st.restoreRows(model, prior, data)
          : prior.map((row) => st.restoreRow(model, row, data));
      for (const u of restores) ctx.undo.push({ model, op: "update", ...u });
      return results[1]?.meta.changes ?? 0;
    },
    async delete(model, where) {
      await ctx.ready();
      if (!ctx.undo) {
        const s = st.delete(model, where);
        if (!s) return 0;
        return (await run(db, s, ctx.sent)).meta.changes;
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
      const rows = await all(db, returning, ctx.sent);
      // The list form for more than one row, as for an update (ruling 84 of plan 12d).
      const reinserts =
        rows.length > 1 && st.reinsertRows
          ? st.reinsertRows(model, rows)
          : rows.map((row) => st.reinsertRow(model, row));
      for (const u of reinserts) ctx.undo.push({ model, op: "delete", ...u });
      return rows.length;
    },
    async transaction(fn) {
      await ctx.ready();
      if (ctx.undo) {
        // A nested call shares the log. A throw reverses only its own entries.
        const log = ctx.undo;
        const mark = log.length;
        const floor = ctx.floor;
        ctx.floor = mark;
        try {
          return await fn(self);
        } catch (e) {
          const own = log.splice(mark);
          return rethrowAfterUndo(db, own, e, ctx.sent);
        } finally {
          ctx.floor = floor;
        }
      }
      const inner: Ctx = { ...ctx, undo: [], floor: 0 };
      const tx = adapterOn(db, inner);
      try {
        return await fn(tx);
      } catch (e) {
        return rethrowAfterUndo(db, inner.undo ?? [], e, ctx.sent);
      }
    },
    statementsSent() {
      return ctx.sent.statements;
    },
  };
  if (ctx.queryLimitPerInvocation) self.queryLimitPerInvocation = true;
  if (ctx.ping) self.ping = ctx.ping;
  if (ctx.sent.ready !== undefined) {
    const counts = ctx.sent;
    self.readyStatements = async () => {
      await ctx.ready();
      return counts.ready ?? 0;
    };
  }
  return self;
}

export function createD1AdapterOn(db: D1Subset, options: D1AdapterOptions): StorageAdapter {
  return adapterOn(db, {
    ...options,
    undo: null,
    sent: options.sent ?? { statements: 0 },
    floor: 0,
  });
}

export { StorageError };
