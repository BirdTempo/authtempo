// The call limits of the remote Worker (plan 11e Task 16). Two parts:
// the token bucket of this file, which is ours, and a RemoteLimiter, which can
// be the platform's rate limit binding. The bucket keeps the promise alone;
// the binding helps and never holds the limit alone.

/**
 * A second limiter behind the token bucket. `limit` answers true when the
 * call may go on, and false when the caller must wait.
 */
export interface RemoteLimiter {
  limit(key: string): Promise<boolean>;
}

/** A limiter that answers the same value for every key, for the tests and for a Worker with no binding. */
export function memoryLimiter(allow: boolean): RemoteLimiter {
  return { limit: async () => allow };
}

/**
 * The shape of the Workers rate limit binding (the "ratelimits" key of
 * wrangler.jsonc, wrangler 4.148.0 config schema, read 2026-10-17). It is
 * written here, so the build of this package needs no Workers type.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * A RemoteLimiter on the Workers rate limit binding. The binding is
 * eventually consistent and local to a location (Cloudflare docs, read
 * 2026-10-14). So the token bucket stays in front of it.
 */
export function bindingLimiter(binding: RateLimitBinding): RemoteLimiter {
  return {
    async limit(key) {
      const { success } = await binding.limit({ key });
      return success;
    },
  };
}

/** The most keys that one bucket holds. A flood of new IPs cannot grow the memory of an isolate past it. */
export const BUCKET_KEYS = 10_000;

/** A token bucket for each key: `take` answers true and spends one token, or answers false. */
export interface TokenBucket {
  take(key: string): boolean;
}

/**
 * A token bucket of `callsPerMinute` tokens for each key, filled again at an
 * even rate over `windowMs`. `clock` answers the time in milliseconds. The
 * state lives in the isolate: a new isolate starts full. At BUCKET_KEYS keys,
 * the bucket drops the key with the oldest call.
 */
export function tokenBucket(
  limits: { readonly callsPerMinute: number; readonly windowMs: number },
  clock: () => number,
): TokenBucket {
  const size = limits.callsPerMinute;
  const perMs = limits.callsPerMinute / limits.windowMs;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key) {
      const now = clock();
      const old = buckets.get(key);
      const tokens = old === undefined ? size : Math.min(size, old.tokens + (now - old.at) * perMs);
      // Delete first, so the map order is the order of the last call.
      buckets.delete(key);
      if (buckets.size >= BUCKET_KEYS) {
        const first = buckets.keys().next();
        if (first.done !== true) buckets.delete(first.value);
      }
      if (tokens < 1) {
        buckets.set(key, { tokens, at: now });
        return false;
      }
      buckets.set(key, { tokens: tokens - 1, at: now });
      return true;
    },
  };
}
