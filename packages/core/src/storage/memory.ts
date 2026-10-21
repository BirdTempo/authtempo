import { type ModelName, type Models, schema } from "../schema.js";
import { type FindManyOptions, type StorageAdapter, StorageError, type Where } from "./port.js";

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

/** The tail of the transaction queue. One per store. */
interface Lock {
  tail: Promise<void>;
}

/**
 * The prefix rule of the port: a non-empty string on a string field, with no
 * lone surrogate. A lone surrogate is no code point, and each engine reads it
 * another way. The guard refuses NUL too, as the SQL codec does in every string.
 */
function assertPrefixes<M extends ModelName>(model: M, where: Where<M>[]): void {
  const fields = schema[model].fields as Record<string, { type: string }>;
  for (const w of where) {
    if (w.op !== "startsWith") continue;
    if (
      fields[w.field]?.type !== "string" ||
      typeof w.value !== "string" ||
      w.value === "" ||
      /\p{Cs}/u.test(w.value) ||
      w.value.includes("\u0000")
    ) {
      throw new StorageError("invalid_argument", model, [w.field]);
    }
  }
}

/**
 * `log` is null outside a transaction. Inside one, every write pushes the
 * step that reverses it, so a rollback touches only this transaction's rows
 * and keeps rows that other callers wrote in the meantime.
 */
function adapterOn(
  store: Store,
  lock: Lock,
  log: Undo[] | null,
  sent: { statements: number },
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

  return {
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
      const sorts =
        opts?.sort === undefined ? [] : Array.isArray(opts.sort) ? opts.sort : [opts.sort];
      assertFields(
        model,
        sorts.map((x) => x.field),
      );
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
        log?.push(() => t.set(r.id as string, r));
      }
      return rows.length;
    },
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const own: Undo[] = [];
        try {
          const value = await fn(adapterOn(store, lock, own, sent));
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
