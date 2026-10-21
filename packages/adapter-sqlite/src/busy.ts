/**
 * How long a libSQL write step waits for the write lock of a local file, and
 * the pause between two tries. A libSQL file client gets SQLITE_BUSY at once
 * when another connection holds the lock. Its `timeout` option blocks the
 * thread, so in one process the holder can never commit (probe 2026-10-21,
 * @libsql/client 0.18.0). So the step tries again after a short pause.
 */
export const BUSY_WAIT_MS = 10_000;
export const BUSY_PAUSE_MS = 20;

function isBusy(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "SQLITE_BUSY";
}

/**
 * Runs `fn` again while it throws SQLITE_BUSY, for at most `capMs`. At the cap
 * the last driver error passes through unchanged, as a busy write does on D1.
 * The error map turns only a unique failure into a StorageError.
 */
export async function retryBusy<T>(
  fn: () => Promise<T>,
  capMs: number = BUSY_WAIT_MS,
  pauseMs: number = BUSY_PAUSE_MS,
): Promise<T> {
  const deadline = Date.now() + capMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}
