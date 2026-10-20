import type { StorageAdapter } from "./port.js";

/** The storage calls of one invocation so far (ruling 34 of plan 12f). */
export interface CallCount {
  calls: number;
}

/**
 * A view of `storage` that adds each call to `count`, also inside a
 * transaction. D1 Free allows 50 queries per invocation, and the operator
 * session calls size their work from the calls left. An update inside a
 * transaction adds 2: there the D1 adapter sends the prior read and the
 * write as one batch of two statements (adapter-d1 `adapter.ts`), and the
 * budget counts each statement of a batch.
 */
export function countedStorage(
  storage: StorageAdapter,
  count: CallCount,
  inTransaction = false,
): StorageAdapter {
  return {
    create(model, data) {
      count.calls++;
      return storage.create(model, data);
    },
    findOne(model, where) {
      count.calls++;
      return storage.findOne(model, where);
    },
    findMany(model, where, opts) {
      count.calls++;
      return storage.findMany(model, where, opts);
    },
    update(model, where, data) {
      count.calls += inTransaction ? 2 : 1;
      return storage.update(model, where, data);
    },
    delete(model, where) {
      count.calls++;
      return storage.delete(model, where);
    },
    transaction(fn) {
      return storage.transaction((tx) => fn(countedStorage(tx, count, true)));
    },
  };
}
