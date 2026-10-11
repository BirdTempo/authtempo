/**
 * The per-isolate gate. One Argon2id or scrypt derive holds up to 32 MiB
 * (the grammar's bounds), and a Workers isolate has 128 MiB for all its
 * requests (Workers limits page, checked 2026-10-10 for plan 9). The derives
 * yield between blocks, so derives from concurrent sign-ins overlap. At most
 * MAX_CONCURRENT derives of every format run at once per isolate; the rest
 * wait in order. bcrypt needs little memory, but its CPU is the largest of
 * the five, so it waits in the same line. The gate never refuses: a refusal
 * would answer invalid_credentials to a right password under load.
 *
 * This is module state, so it is per isolate. The Better Auth seam of plan 9
 * has its own gate of two; an app that chains both can run four derives at
 * once, 128 MiB at the worst, and should chain only the one it needs.
 */
export const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];

export async function gated<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    // The finishing derive hands its slot to the next waiter, so `running` stays at the limit.
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running++;
  }
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** For tests: the derives that hold a slot now. */
export function gateRunning(): number {
  return running;
}
