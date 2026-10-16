import type { ResolvedConfig } from "../src/config.js";
import type { ModelName } from "../src/schema.js";
import { type StorageAdapter, StorageError } from "../src/storage/port.js";
import { undoCreateWhere } from "../src/storage/sql.js";

/**
 * The config with a storage whose transactions are not isolated, as on D1:
 * each statement of the transaction function runs at once on the shared
 * rows, and a throw runs this transaction's own undo log in reverse, as the
 * D1 adapter does. The undo of a create deletes `undoCreateWhere(...)`, the
 * D1 adapter's rule: a user created unverified only while it is still
 * unverified. The undo of an update writes back only the fields the update
 * set, the D1 adapter's rule too. A nested call shares the log and a throw reverses only its own
 * entries. A failed entry does not stop the rest. When any entry fails, the
 * throw is one rollback_failed error with `{ original, failures }` as its
 * cause and `<model>:<op>` for each failed entry, as the D1 adapter's
 * `rethrowAfterUndo` throws, so a core test sees the error that real D1
 * answers (plan 9 Task 4 review M-1). A flow on this view does
 * not wait for the memory adapter's transaction lock, so it can run inside
 * another flow's open transaction.
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
          // changed another field inside this transaction stays.
          const fields = Object.keys(data);
          for (const row of before) {
            const all = row as unknown as { id: string } & Record<string, unknown>;
            const back = Object.fromEntries(fields.map((f) => [f, all[f]]));
            log.push({
              model,
              op: "update",
              run: () =>
                raw.update(model, [{ field: "id", op: "eq", value: all.id }], back as never),
            });
          }
          return n;
        },
        async delete(model, where) {
          const before = await raw.findMany(model, where);
          const n = await raw.delete(model, where);
          for (const row of before)
            log.push({ model, op: "delete", run: () => raw.create(model, row) });
          return n;
        },
        async transaction<U>(inner: (t: StorageAdapter) => Promise<U>): Promise<U> {
          const mark = log.length;
          try {
            return await inner(tx);
          } catch (e) {
            return rollback(log.splice(mark), e);
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
