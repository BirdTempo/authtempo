import type { ResolvedConfig } from "../src/config.js";
import type { ModelName } from "../src/schema.js";
import { type StorageAdapter, StorageError, type Where } from "../src/storage/port.js";
import { undoCreateWhere } from "../src/storage/sql.js";

/** A null-safe compare of a stored value and a written value. A date compares by its time. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The config with a storage whose transactions are not isolated, as on D1.
 * Each statement of the transaction function runs at once on the shared
 * rows. A throw runs this transaction's own undo log in reverse, as the D1
 * adapter does. The undo of a create deletes `undoCreateWhere(...)`, the D1
 * adapter's rule: a user created unverified goes only while it is still
 * unverified. The undo of an update writes back only the fields the update
 * set, each one only while it holds the written value: the D1 adapter's rule
 * too. A nested call shares the log, and a throw reverses only its own
 * entries. A failed entry does not stop the rest. `keep` drops the entries of
 * its level so far, and `deleteRows` logs the rows that it answered, as the
 * D1 adapter does (plan 12o).
 * When any entry fails, the throw is one rollback_failed error. Its cause is
 * `{ original, failures }`, and it names `<model>:<op>` for each failed
 * entry, as the D1 adapter's `rethrowAfterUndo` throws. So a core test sees
 * the error that real D1 answers (plan 9 Task 4 review M-1). A flow on this
 * view does not wait for the memory adapter's transaction lock, so it can
 * run inside another flow's open transaction.
 * `undoOnlyWhile` keeps the D1 adapter's rule (decision 6 of plan 12q): the
 * undo of each later delete puts its row back only while a row matches the
 * condition when the undo runs. A second call at a level replaces it, a
 * nested call starts with the condition of its parent, and `keep` and the
 * end of a level end the condition that the level set.
 */
export function d1Like(config: ResolvedConfig): ResolvedConfig {
  const raw = config.storage;
  type Undo = { model: ModelName; op: "create" | "update" | "delete"; run: () => Promise<unknown> };
  const rollback = async (entries: Undo[], original: unknown): Promise<never> => {
    const failures: unknown[] = [];
    const fields: string[] = [];
    for (const u of entries.reverse()) {
      try {
        await u.run();
      } catch (f) {
        failures.push(f);
        fields.push(`${u.model}:${u.op}`);
      }
    }
    if (failures.length === 0) throw original;
    const model = original instanceof StorageError ? original.model : "meta";
    throw new StorageError("rollback_failed", model, fields, { cause: { original, failures } });
  };
  const view: StorageAdapter = {
    ...raw,
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      const log: Undo[] = [];
      // The first entry that the open nested call owns, as in the D1 adapter.
      let floor = 0;
      // The condition of `undoOnlyWhile` for the next delete, and the one that the open level started with.
      type Guard = { model: ModelName; where: Where<ModelName>[] };
      let guard: Guard | null = null;
      let inherited: Guard | null = null;
      /** The undo of a deleted row: it puts the row back, under a condition only while a row matches it then. */
      const putBack = (model: ModelName, row: never): Undo => {
        const g = guard;
        return {
          model,
          op: "delete",
          run: async () => {
            if (g && !(await raw.findOne(g.model, g.where))) return null;
            return raw.create(model, row);
          },
        };
      };
      const tx: StorageAdapter = {
        ...raw,
        async create(model, data) {
          const row = await raw.create(model, data);
          log.push({
            model,
            op: "create",
            run: () => raw.delete(model, undoCreateWhere(model, data)),
          });
          return row;
        },
        async update(model, where, data) {
          const before = await raw.findMany(model, where);
          const n = await raw.update(model, where, data);
          // The D1 adapter's rule (`SqlStatements.restoreRow`): the undo
          // writes back only the fields the update set, so a claim that
          // changed another field inside this transaction stays. Each field
          // goes back on its own, and only while it holds the value the
          // update wrote, so a later write of another request stays.
          const fields = Object.keys(data);
          const wrote = data as Record<string, unknown>;
          for (const row of before) {
            const all = row as unknown as { id: string } & Record<string, unknown>;
            const byId = [{ field: "id" as const, op: "eq" as const, value: all.id }];
            log.push({
              model,
              op: "update",
              run: async () => {
                const now = (await raw.findOne(model, byId as never)) as Record<
                  string,
                  unknown
                > | null;
                if (!now) return 0;
                const back = Object.fromEntries(
                  fields.filter((f) => same(now[f], wrote[f])).map((f) => [f, all[f]]),
                );
                if (Object.keys(back).length === 0) return 0;
                return raw.update(model, byId as never, back as never);
              },
            });
          }
          return n;
        },
        async delete(model, where) {
          const before = await raw.findMany(model, where);
          const n = await raw.delete(model, where);
          for (const row of before) log.push(putBack(model, row as never));
          return n;
        },
        async deleteRows(model, where) {
          // The rows that the delete removed, each with its undo (plan 12o).
          const rows = await raw.deleteRows(model, where);
          for (const row of rows) log.push(putBack(model, row as never));
          return rows;
        },
        async keep() {
          // The D1 adapter's rule (plan 12o): the entries of this level so far go.
          // The condition that this level set ends too (plan 12q).
          log.splice(floor);
          guard = inherited;
          return true;
        },
        async undoOnlyWhile(model, where) {
          // No read here: the call sends no statement on D1.
          const terms = where as Where<ModelName>[];
          if (guard && guard !== inherited) {
            guard.model = model;
            guard.where = terms;
          } else guard = { model, where: terms };
        },
        async transaction<U>(inner: (t: StorageAdapter) => Promise<U>): Promise<U> {
          const mark = log.length;
          const outer = floor;
          const before = { guard, inherited };
          floor = mark;
          inherited = guard;
          try {
            return await inner(tx);
          } catch (e) {
            return rollback(log.splice(mark), e);
          } finally {
            floor = outer;
            guard = before.guard;
            inherited = before.inherited;
          }
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        return rollback(log, e);
      }
    },
  };
  return { ...config, storage: view };
}
