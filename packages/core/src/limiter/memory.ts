import type { Clock } from "../primitives/clock.js";
import { KEY_SEPARATOR, type LimiterPort, type LimitWindow } from "./port.js";

/**
 * The stored key of every limiter: the key, the seconds, and the max, joined
 * by `KEY_SEPARATOR` (U+001F). The window is part of the identity, so one key
 * under two windows is two limits. The memory, D1, and Postgres limiters all
 * read this one function. A key with `|` is an ordinary key.
 */
export function limiterKey(key: string, window: LimitWindow): string {
  // normalizeEmail refuses control characters, and the default `clientIp`
  // gives none. A custom hook that returns one makes that request throw.
  // A key with it would alias another window.
  if (key.includes(KEY_SEPARATOR)) {
    throw new Error(
      "authtempo limiter: a key must not contain U+001F, the separator of the stored key",
    );
  }
  // A zero or fractional window has no meaning: `max: 0` refuses all on SQL
  // and allows the first call on memory, and `seconds: 0` limits nothing.
  // Postgres also casts the window milliseconds to bigint.
  if (!isPositiveSafeInteger(window.seconds) || !isPositiveSafeInteger(window.max)) {
    throw new Error(
      `authtempo limiter: seconds and max must be positive safe integers, got ${window.seconds} and ${window.max}`,
    );
  }
  return `${key}${KEY_SEPARATOR}${window.seconds}${KEY_SEPARATOR}${window.max}`;
}

function isPositiveSafeInteger(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * A fixed-window counter in memory. On Workers every isolate has its own
 * copy, so the real limit is this limit times the isolate count. Version 1
 * documents that. A Durable Object limiter is a version 2 item.
 */
export function createMemoryLimiter(clock: Clock): LimiterPort & { size(): number } {
  const buckets = new Map<string, { start: number; count: number; seconds: number }>();
  // Each bucket expires by its own window, not the window of the caller.
  function drop(now: number): number {
    let dropped = 0;
    for (const [k, v] of buckets) {
      if (v.start + v.seconds * 1000 <= now) {
        buckets.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }
  return {
    size: () => buckets.size,
    async sweep(now) {
      return drop(now.getTime());
    },
    async allow(key, window) {
      const id = limiterKey(key, window);
      const now = clock.now().getTime();
      // Keys carry caller-chosen values, so drop every expired bucket here.
      // Without this sweep a long-lived isolate keeps every key it ever saw.
      drop(now);
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
