import { ipKey } from "@authtempo/core";

/** The window of the count: the key requestsPerIpPerMinute of DEMO_LIMITS names one minute. */
const WINDOW_MS = 60_000;

/**
 * The first limit of the Worker (final review m7 of plan 11b). It counts the
 * requests of each IP key in one isolate, before any Durable Object call. An
 * IPv6 address counts by the key of core ipKey, as the gate counts it.
 *
 * This limit is weak. Cloudflare runs many isolates, and each isolate counts
 * alone, so a flood across many isolates passes. It stops one client that
 * floods one isolate. The WAF rate rule at publication is the strong control,
 * and it is an owner input (README, owner list).
 */
export class IsolateCount {
  private readonly counts = new Map<string, { start: number; n: number }>();

  /** At most `limit` requests per key per minute, with at most `maxKeys` keys in memory. */
  constructor(
    private readonly limit: number,
    private readonly maxKeys: number,
  ) {}

  /** Counts one request of `address` at `now`, and answers true while the key is within the limit. */
  take(address: string, now: number): boolean {
    const key = ipKey(address);
    let entry = this.counts.get(key);
    if (entry === undefined || now - entry.start >= WINDOW_MS) {
      if (entry === undefined && this.counts.size >= this.maxKeys) this.prune(now);
      entry = { start: now, n: 0 };
      this.counts.set(key, entry);
    }
    entry.n += 1;
    return entry.n <= this.limit;
  }

  /** The end of the window of the key of `address`, in ms since the epoch. */
  until(address: string, now: number): number {
    return (this.counts.get(ipKey(address))?.start ?? now) + WINDOW_MS;
  }

  /** Deletes each ended window. When every window is live, it starts again with no key. */
  private prune(now: number): void {
    for (const [key, entry] of this.counts)
      if (now - entry.start >= WINDOW_MS) this.counts.delete(key);
    if (this.counts.size >= this.maxKeys) this.counts.clear();
  }
}
