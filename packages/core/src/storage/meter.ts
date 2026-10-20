import type { StorageAdapter } from "./port.js";

/**
 * The count of the calls of one invocation so far (rulings 35 and 37 of
 * plan 12f). It starts at `fixed`. With `statementsSent`, a storage step
 * counts as the difference of the counter since the start. With no
 * counter, each `step` adds its worst case. `add` counts a call that the
 * counter cannot see, such as a fetch or a query of the limiter: it adds
 * in both cases.
 */
export interface Meter {
  /** A storage step: its worst case counts only when the storage has no counter. */
  step(worst: number): void;
  /** A call outside the storage counter: it always counts. */
  add(n: number): void;
  readonly used: number;
}

export function meterOf(storage: StorageAdapter, fixed: number): Meter {
  const start = storage.statementsSent?.();
  let outside = fixed;
  let assumed = 0;
  return {
    step(worst: number) {
      assumed += worst;
    },
    add(n: number) {
      outside += n;
    },
    get used(): number {
      const now = storage.statementsSent?.();
      return outside + (start === undefined || now === undefined ? assumed : now - start);
    },
  };
}
