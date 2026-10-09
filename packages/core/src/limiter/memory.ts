import type { Clock } from "../primitives/clock.js";
import { KEY_SEPARATOR, type LimiterPort, type LimitWindow } from "./port.js";

/**
 * The stored key of every limiter: the key, the seconds, and the max, joined
 * by `KEY_SEPARATOR` (U+001F). The window is part of the identity, so one key
 * under two windows is two limits. The memory, D1, and Postgres limiters all
 * read this one function. A key with `|` is an ordinary key.
 */
export function limiterKey(key: string, window: LimitWindow): string {
  // No caller value can carry it: normalizeEmail refuses control characters
  // and an IP address has none. A key with it would alias another window.
  if (key.includes(KEY_SEPARATOR)) {
    throw new Error(
      "tempo-auth limiter: a key must not contain U+001F, the separator of the stored key",
    );
  }
  return `${key}${KEY_SEPARATOR}${window.seconds}${KEY_SEPARATOR}${window.max}`;
}

/**
 * A fixed-window counter in memory. On Workers every isolate has its own
 * copy, so the real limit is this limit times the isolate count. Version 1
 * documents that. A Durable Object limiter is a version 2 item.
 */
export function createMemoryLimiter(clock: Clock): LimiterPort & { size(): number } {
  const buckets = new Map<string, { start: number; count: number; seconds: number }>();
  return {
    size: () => buckets.size,
    async allow(key, window) {
      const id = limiterKey(key, window);
      const now = clock.now().getTime();
      // Keys carry caller-chosen values, so drop every expired bucket here.
      // Each bucket expires by its own window, not the window of this call.
      // Without this sweep a long-lived isolate keeps every key it ever saw.
      for (const [k, v] of buckets) {
        if (v.start + v.seconds * 1000 <= now) buckets.delete(k);
      }
      // The window is part of the bucket identity, so a stored window never goes stale.
      const b = buckets.get(id);
      if (!b || now - b.start >= window.seconds * 1000) {
        buckets.set(id, { start: now, count: 1, seconds: window.seconds });
        return true;
      }
      if (b.count >= window.max) return false;
      b.count += 1;
      return true;
    },
  };
}
