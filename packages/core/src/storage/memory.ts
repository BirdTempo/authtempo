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
      case "ne":
        return v !== norm(w.value);
      case "in":
        return (w.value as unknown[]).some((x) => norm(x) === v);
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

function checkUnique(
  model: ModelName,
  table: Map<string, Record<string, unknown>>,
  row: Record<string, unknown>,
): void {
  for (const key of schema[model].unique) {
    for (const other of table.values()) {
      if (other.id === row.id) continue;
      if (key.every((f) => norm(other[f]) === norm(row[f]))) {
        throw new StorageError("unique_violation", model, key);
      }
    }
  }
}

function adapterOn(store: Store): StorageAdapter {
  const table = (model: ModelName) => {
    if (!(model in schema)) throw new StorageError("unknown_model", model);
    let t = store.get(model);
    if (!t) {
      t = new Map();
      store.set(model, t);
    }
    return t;
  };

  const select = <M extends ModelName>(model: M, where: Where<M>[]) => {
    assertFields(
      model,
      where.map((w) => w.field),
    );
    return [...table(model).values()].filter((r) => matches(r, where));
  };

  return {
    async create<M extends ModelName>(model: M, data: Models[M]): Promise<Models[M]> {
      const t = table(model);
      assertFields(model, Object.keys(data));
      const row = clone(data as unknown as Record<string, unknown>);
      checkUnique(model, t, row);
      t.set(row.id as string, row);
      return clone(row) as unknown as Models[M];
    },
    async findOne<M extends ModelName>(model: M, where: Where<M>[]): Promise<Models[M] | null> {
      const rows = select(model, where);
      return rows.length ? (clone(rows[0]) as unknown as Models[M]) : null;
    },
    async findMany<M extends ModelName>(
      model: M,
      where: Where<M>[],
      opts?: FindManyOptions<M>,
    ): Promise<Models[M][]> {
      let rows = select(model, where);
      if (opts?.sort) {
        const { field, dir } = opts.sort;
        assertFields(model, [field]);
        rows = rows.sort((a, b) => {
          const x = norm(a[field]);
          const y = norm(b[field]);
          const c = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
          return dir === "asc" ? c : -c;
        });
      }
      if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
      return rows.map((r) => clone(r) as unknown as Models[M]);
    },
    async update<M extends ModelName>(
      model: M,
      where: Where<M>[],
      data: Partial<Models[M]>,
    ): Promise<number> {
      const t = table(model);
      assertFields(model, Object.keys(data));
      const rows = select(model, where);
      for (const r of rows) {
        const next = { ...r, ...clone(data as unknown as Record<string, unknown>) };
        checkUnique(model, t, next);
        t.set(r.id as string, next);
      }
      return rows.length;
    },
    async delete<M extends ModelName>(model: M, where: Where<M>[]): Promise<number> {
      const t = table(model);
      const rows = select(model, where);
      for (const r of rows) t.delete(r.id as string);
      return rows.length;
    },
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      const snapshot: Store = new Map();
      for (const [m, t] of store) snapshot.set(m, new Map([...t].map(([k, v]) => [k, clone(v)])));
      try {
        return await fn(adapterOn(store));
      } catch (e) {
        store.clear();
        for (const [m, t] of snapshot) store.set(m, t);
        throw e;
      }
    },
  };
}

/** An adapter that keeps rows in memory. For tests and the example Worker only. */
export function createMemoryAdapter(): StorageAdapter {
  return adapterOn(new Map());
}
