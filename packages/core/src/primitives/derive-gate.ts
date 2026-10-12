/**
 * The per-isolate gate for legacy password derives (spec 16.3 and 17.2 as
 * amended by plan 9b2). One Argon2id or scrypt derive holds up to 32 MiB,
 * and a Workers isolate has 128 MiB for all its requests (Workers limits
 * page, checked 2026-10-10 for plan 9). The derives yield between blocks, so
 * the derives of concurrent sign-ins overlap, and four of them can end the
 * isolate. A memory kill of the isolate is not a throw, so no catch sees it,
 * and every request of the isolate fails; the gate must stop the derive
 * before it starts. At most `max` derives run at once; the rest wait in
 * order. bcrypt needs little memory, but its CPU is the largest of the
 * legacy formats, so it waits in the same line. The gate never refuses: a
 * refusal would answer invalid_credentials to a right password under load.
 *
 * `deriveGate` is module state of core, so every seam in one isolate shares
 * it: `createLegacyPasswordHash` of `@tempo-auth/legacy-hashes` and
 * `betterAuthPasswordHash` of `@tempo-auth/compat-better-auth`. A chain of
 * both seams runs at most two derives at once, not four. Neither package
 * keeps a gate of its own (plan 9b2).
 *
 * The share holds only with one copy of core in the app. A second copy (two
 * versions of `@tempo-auth/core` in the dependency tree) has a second gate,
 * and a chain can then run four derives. Both seam packages declare core as
 * a peer dependency, so a package manager warns on a version that does not
 * match; keep one version of core.
 */
export interface DeriveGate {
  /** The most derives that run at once. */
  readonly max: number;
  /** Runs `work` when a slot is free, else waits in order. Never refuses. A throw frees the slot. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** For tests: the derives that hold a slot now. */
  running(): number;
  /** For tests: the derives that wait now. */
  waiting(): number;
}

/** Two derives of 32 MiB each leave half of the isolate's memory for the requests. */
export const DERIVE_GATE_MAX = 2;

export function createDeriveGate(max: number): DeriveGate {
  if (!Number.isSafeInteger(max) || max < 1)
    throw new Error(
      `tempo-auth: a derive gate needs a whole number of slots of at least 1, not ${String(max)}`,
    );
  let running = 0;
  const queue: Array<() => void> = [];
  return {
    max,
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (running >= max) {
        // The finishing derive hands its slot to the next waiter, so `running` stays at the limit.
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        running++;
      }
      try {
        return await work();
      } finally {
        const next = queue.shift();
        if (next) next();
        else running--;
      }
    },
    running: () => running,
    waiting: () => queue.length,
  };
}

/** The one gate of the isolate. Both legacy seams run every derive through it. */
export const deriveGate: DeriveGate = createDeriveGate(DERIVE_GATE_MAX);
