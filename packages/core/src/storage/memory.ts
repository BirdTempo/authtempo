import { type ModelName, type Models, schema } from "../schema.js";
import { type FindManyOptions, type StorageAdapter, StorageError, type Where } from "./port.js";
import {
  assertWhereText,
  coreStatements,
  D1_BOUND_PARAMS,
  insertChunks,
  rowsPerInsertOf,
  SQLITE,
  sortsOf,
} from "./sql.js";

type Store = Map<ModelName, Map<string, Record<string, unknown>>>;

function norm(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

function assertFields(model: ModelName, fields: Iterable<string>): void {
  const def = schema[model];
  for (const f of fields) {
    if (!(f in def.fields)) throw new StorageError("unknown_field", model, [f]);
  }
}

function matches<M extends ModelName>(row: Record<string, unknown>, where: Where<M>[]): boolean {
  return where.every((w) => {
    const v = norm(row[w.field]);
    switch (w.op) {
      case "eq":
        return v === norm(w.value);
      case "ne": {
        // SQL: "<> x" excludes NULL rows; "ne null" is IS NOT NULL.
        const t = norm(w.value);
        return t === null ? v !== null : v !== null && v !== t;
      }
      case "in":
        // SQL: IN never matches a NULL row, even if the list holds null.
        return v !== null && (w.value as unknown[]).some((x) => norm(x) === v);
      case "startsWith":
        // assertPrefixes refuses a lone surrogate, so the prefix is whole code points.
        // For well-formed text, this agrees with SQL substr.
        return typeof v === "string" && v.startsWith(w.value as string);
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const t = norm(w.value);
        if (v === null || t === null) return false;
        if (w.op === "lt") return v < t;
        if (w.op === "lte") return v <= t;
        if (w.op === "gt") return v > t;
        return v >= t;
      }
      default:
        // Unreachable for a valid Op. Keeps every path returning a value.
        return false;
    }
  });
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** True when two rows hold the same values for a unique key. Null in any field never conflicts, as in SQL. */
export function sameUniqueKey(
  key: readonly string[],
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return key.every((f) => {
    const x = norm(a[f]);
    return x !== null && x === norm(b[f]);
  });
}

function checkUnique(
  model: ModelName,
  others: Iterable<Record<string, unknown>>,
  row: Record<string, unknown>,
): void {
  // One array for every key: an iterator such as Map.values() is spent after
  // the first key, and a model with two unique keys (plan 12e) then never
  // checks its second key.
  const rows = [...others];
  for (const key of schema[model].unique as readonly (readonly string[])[]) {
    for (const other of rows) {
      if (sameUniqueKey(key, other, row)) {
        throw new StorageError("unique_violation", model, key);
      }
    }
  }
}

/**
 * Reverses one write. A transaction keeps a list of these for its own writes.
 * If an outside caller changes the same row during the transaction, the
 * rollback puts back the prior row. The memory adapter does not detect that
 * write conflict.
 */
type Undo = () => void;

/**
 * The condition of `undoOnlyWhile` at one transaction level (decision 6 of
 * plan 12q). Each undo step of a delete under it reads it when the step
 * runs. So a second call at the level changes it for each of them. `also`
 * is the second condition of the call, or null (ruling 36 of plan 12q).
 */
interface UndoGuard {
  model: ModelName;
  where: Where<ModelName>[];
  also: { model: ModelName; where: Where<ModelName>[] } | null;
}

/** The tail of the transaction queue. One per store. */
interface Lock {
  tail: Promise<void>;
}

/**
 * The prefix rule of the port: a non-empty string on a string field. Each
 * where value also meets the text rule of the SQL builder. So a NUL or a
 * lone surrogate throws as on every store (rulings 16 and 17 of plan 12g).
 */
function assertPrefixes<M extends ModelName>(model: M, where: Where<M>[]): void {
  const fields = schema[model].fields as Record<string, { type: string }>;
  for (const w of where) {
    assertWhereText(model, w.field, w.value);
    if (w.op !== "startsWith") continue;
    if (fields[w.field]?.type !== "string" || typeof w.value !== "string" || w.value === "") {
      throw new StorageError("invalid_argument", model, [w.field]);
    }
  }
}

/**
 * `log` is null outside a transaction. Inside one, every write pushes the
 * step that reverses it, so a rollback touches only this transaction's rows
 * and keeps rows that other callers wrote in the meantime.
 * `inherited` is the condition of `undoOnlyWhile` that this level starts
 * with: its parent's, or null at the top level.
 */
function adapterOn(
  store: Store,
  lock: Lock,
  log: Undo[] | null,
  sent: { statements: number },
  inherited: UndoGuard | null = null,
): StorageAdapter {
  const table = (model: ModelName) => {
    if (!Object.hasOwn(schema, model)) throw new StorageError("unknown_model", model);
    let t = store.get(model);
    if (!t) {
      t = new Map();
      store.set(model, t);
    }
    return t;
  };

  const select = <M extends ModelName>(model: M, where: Where<M>[]) => {
    // Check the model first. assertFields reads schema[model].
    const t = table(model);
    assertFields(
      model,
      where.map((w) => w.field),
    );
    // Before the filter, so an empty table refuses a bad prefix as SQL does.
    assertPrefixes(model, where);
    return [...t.values()].filter((r) => matches(r, where));
  };

  // The statements of D1, so a call counts as a D1 call does (rulings 57 and 84 of plan 12d).
  const d1 = coreStatements(SQLITE);

  /** The condition of `undoOnlyWhile` for the next delete of this level, or null (plan 12q). */
  let guard: UndoGuard | null = inherited;
  /**
   * The undo step of a deleted row: it puts the row back. Under a
   * condition, only while a row matches it when the step runs.
   */
  const putBack = (t: Map<string, Record<string, unknown>>, r: Record<string, unknown>): Undo => {
    const g = guard;
    return () => {
      if (g && select(g.model, g.where).length === 0) return;
      if (g?.also && select(g.also.model, g.also.where).length === 0) return;
      t.set(r.id as string, r);
    };
  };

  return {
    // An undo log, and each write is seen at once (plan 12p): the claim takes a lease.
    isolated: false,
    async create<M extends ModelName>(model: M, data: Models[M]): Promise<Models[M]> {
      sent.statements++;
      const t = table(model);
      assertFields(model, Object.keys(data));
      const row = clone(data as unknown as Record<string, unknown>);
      if (t.has(row.id as string)) throw new StorageError("unique_violation", model, ["id"]);
      checkUnique(model, t.values(), row);
      t.set(row.id as string, row);
      log?.push(() => t.delete(row.id as string));
      return clone(row) as unknown as Models[M];
    },
    async createMany<M extends ModelName>(
      model: M,
      rows: readonly Models[M][],
    ): Promise<Models[M][]> {
      const t = table(model);
      if (rows.length === 0) return [];
      // All or nothing: check each row against the table and the rows before it, then write.
      const added: Record<string, unknown>[] = [];
      for (const data of rows) {
        assertFields(model, Object.keys(data));
        const row = clone(data as unknown as Record<string, unknown>);
        if (t.has(row.id as string) || added.some((r) => r.id === row.id))
          throw new StorageError("unique_violation", model, ["id"]);
        checkUnique(model, [...t.values(), ...added], row);
        added.push(row);
      }
      // The chunks of D1, so the call counts as a D1 call does (rulings 57 and 84 of plan 12d).
      sent.statements += insertChunks(d1, model, rows, D1_BOUND_PARAMS).length;
      for (const row of added) {
        t.set(row.id as string, row);
        log?.push(() => t.delete(row.id as string));
      }
      return added.map((r) => clone(r) as unknown as Models[M]);
    },
    rowsPerInsert(model: ModelName): number {
      table(model);
      return rowsPerInsertOf(d1, model, D1_BOUND_PARAMS);
    },
    async findOne<M extends ModelName>(model: M, where: Where<M>[]): Promise<Models[M] | null> {
      sent.statements++;
      const rows = select(model, where);
      return rows.length ? (clone(rows[0]) as unknown as Models[M]) : null;
    },
    async findMany<M extends ModelName>(
      model: M,
      where: Where<M>[],
      opts?: FindManyOptions<M>,
    ): Promise<Models[M][]> {
      sent.statements++;
      let rows = select(model, where);
      const limit = opts?.limit;
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0)) {
        throw new StorageError("invalid_argument", model, ["limit"]);
      }
      const sorts = sortsOf(model, opts);
      if (sorts.length > 0) {
        rows = rows.sort((a, b) => {
          for (const { field, dir } of sorts) {
            const x = norm(a[field]);
            const y = norm(b[field]);
            // Nulls sort highest: last ascending, first descending.
            const c = x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
            if (c !== 0) return dir === "asc" ? c : -c;
          }
          return 0;
        });
      }
      if (limit !== undefined) rows = rows.slice(0, limit);
      return rows.map((r) => clone(r) as unknown as Models[M]);
    },
    async update<M extends ModelName>(
      model: M,
      where: Where<M>[],
      data: Partial<Omit<Models[M], "id">>,
    ): Promise<number> {
      sent.statements++;
      const t = table(model);
      assertFields(model, Object.keys(data));
      if (Object.hasOwn(data, "id")) throw new StorageError("unknown_field", model, ["id"]);
      if (where.length === 0) throw new StorageError("invalid_argument", model, ["where"]);
      const rows = select(model, where);
      // All or nothing: build every next row, check each against the table
      // with the batch applied, and only then write.
      const patch = clone(data as unknown as Record<string, unknown>);
      const touched = new Set(rows.map((r) => r.id as string));
      const applied = [...t.values()].filter((r) => !touched.has(r.id as string));
      const nexts: Record<string, unknown>[] = [];
      for (const r of rows) {
        const next = { ...r, ...clone(patch) };
        checkUnique(model, applied, next);
        applied.push(next);
        nexts.push(next);
      }
      for (const next of nexts) t.set(next.id as string, next);
      // A write replaces the row object and never mutates it, so `r` is the prior row.
      for (const r of rows) log?.push(() => t.set(r.id as string, r));
      return rows.length;
    },
    async delete<M extends ModelName>(model: M, where: Where<M>[]): Promise<number> {
      sent.statements++;
      const t = table(model);
      if (where.length === 0) throw new StorageError("invalid_argument", model, ["where"]);
      const rows = select(model, where);
      for (const r of rows) {
        t.delete(r.id as string);
        log?.push(putBack(t, r));
      }
      return rows.length;
    },
    async deleteRows<M extends ModelName>(model: M, where: Where<M>[]): Promise<Models[M][]> {
      sent.statements++;
      const t = table(model);
      if (where.length === 0) throw new StorageError("invalid_argument", model, ["where"]);
      const rows = select(model, where);
      for (const r of rows) {
        t.delete(r.id as string);
        log?.push(putBack(t, r));
      }
      return rows.map((r) => clone(r) as unknown as Models[M]);
    },
    async deleteOnlyWhile<M extends ModelName, G extends ModelName>(
      model: M,
      where: Where<M>[],
      whileModel: G,
      whileWhere: Where<G>[],
    ): Promise<number> {
      // One statement, as on D1: the check of the condition is a term of the delete (plan 12q).
      sent.statements++;
      const t = table(model);
      if (where.length === 0) throw new StorageError("invalid_argument", model, ["where"]);
      const rows = select(model, where);
      if (select(whileModel, whileWhere).length === 0) return 0;
      for (const r of rows) {
        t.delete(r.id as string);
        log?.push(putBack(t, r));
      }
      return rows.length;
    },
    async keep() {
      // The steps so far go, so a later throw reverses only the later writes.
      // A nested call holds its own list, so it drops only its own steps.
      // Outside a transaction no write is reversed. The condition of
      // `undoOnlyWhile` that this level set ends too (plan 12q).
      if (log) log.length = 0;
      guard = inherited;
      return true;
    },
    async undoOnlyWhile<M extends ModelName, G extends ModelName = M>(
      model: M,
      where: Where<M>[],
      also?: { model: G; where: Where<G>[] },
    ): Promise<void> {
      // The checks of a read: the model, each field, and each value. No call counts.
      select(model, where);
      if (also) select(also.model, also.where);
      const terms = where as Where<ModelName>[];
      const second = also ? { model: also.model, where: also.where as Where<ModelName>[] } : null;
      // A second call at this level changes the condition of its deletes so far.
      // Outside a transaction no delete has an undo, and `transaction` starts with none.
      if (guard && guard !== inherited) {
        guard.model = model;
        guard.where = terms;
        guard.also = second;
      } else guard = { model, where: terms, also: second };
    },
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const own: Undo[] = [];
        try {
          // A nested call starts with the condition of its parent (plan 12q).
          const value = await fn(adapterOn(store, lock, own, sent, log ? guard : null));
          // A nested transaction hands its steps to the outer one, so an
          // outer rollback also reverses them.
          log?.push(...own);
          return value;
        } catch (e) {
          for (let i = own.length - 1; i >= 0; i--) own[i]?.();
          throw e;
        }
      };
      // A nested call already holds the lock. Waiting for it would deadlock.
      if (log) return run();
      // Transactions run one at a time, like SERIALIZABLE in SQL. A write
      // outside a transaction does not wait.
      const result = lock.tail.then(run);
      lock.tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    statementsSent() {
      return sent.statements;
    },
    async ping() {
      // Memory has no schema version: the store is ready while the process runs.
      sent.statements++;
    },
  };
}

/** An adapter that keeps rows in memory. For tests and the example Worker only. */
export function createMemoryAdapter(): StorageAdapter {
  // The count of port calls, shared with each transaction (ruling 35 of plan 12f).
  return adapterOn(new Map(), { tail: Promise.resolve() }, null, { statements: 0 });
}
