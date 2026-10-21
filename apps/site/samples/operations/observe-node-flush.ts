import type { Auth } from "@authtempo/core";

/**
 * Node and Bun have no `waitUntil`, so a timer flushes the buffer. Call
 * the answer at shutdown: it stops the timer and sends the last batch.
 */
export function startFlush(auth: Auth, everyMs = 5000): () => Promise<void> {
  const timer = setInterval(() => void auth.observe.flush(), everyMs);
  return async () => {
    clearInterval(timer);
    await auth.observe.flush();
  };
}
