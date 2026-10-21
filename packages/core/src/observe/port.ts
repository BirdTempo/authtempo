/**
 * The observe port (plan 12h, spec 31 item 1). The sink is the seam (spec 31
 * item 1). Core names no supplier. A sink is app code with the app's trust,
 * as the mail port is.
 */

/** The name of an event. Plan 12h Task 3 narrows it to the keys of `EVENTS`. */
export type EventName = string;

/** One event as a sink gets it. No field holds a secret, a credential, or free text (spec 31 item 8). */
export interface AuthEvent {
  name: EventName;
  level: "info" | "warn" | "error";
  /** UTC, ISO 8601, from `config.clock`. */
  at: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  route?: string;
  rejected?: string[];
  [field: string]: unknown;
}

/** The app's sink. `write` gets one batch for each flush, and core waits for it for at most `flushTimeoutMs`. */
export interface ObserveSink {
  write(batch: readonly AuthEvent[]): void | Promise<void>;
}

export interface ObserveConfig {
  sink: ObserveSink;
  /** What an event may hold of an address. Each key defaults to `none`. A raw email is never written. */
  include?: { ip?: "none" | "hash" | "raw"; userAgent?: "none" | "raw"; email?: "none" | "hash" };
  /** Take the trace id of a valid W3C `traceparent` header. Default false. */
  trustTraceparent?: boolean;
  /** The events that the buffer holds between two flushes, 10 to 10000. Default 1000. */
  buffer?: number;
  /** The time that a flush waits for `sink.write`, 100 to 10000 ms. Default 2000. */
  flushTimeoutMs?: number;
  /** Mount `GET <basePath>/ready`. Default false. */
  readiness?: boolean;
}

/** The counts of one `Auth` instance, in process. No route answers them. */
export interface ObserveStats {
  buffered: number;
  dropped: { buffer_full: number; sink_timeout: number; sink_threw: number };
}

export interface HandleOptions {
  /**
   * The host's hook that keeps the flush alive after the answer. On Workers
   * pass `(p) => ctx.waitUntil(p)`: an unbound `ctx.waitUntil` throws.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}
