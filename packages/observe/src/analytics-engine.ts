/**
 * The Analytics Engine sink of `@authtempo/observe` (plan 12h, spec 31 item
 * 13). It writes one data point for each event of a chosen list, with the
 * event name as the index and the fields in the fixed order of `AE_BLOBS`.
 *
 * Analytics Engine samples by index on write and on read. Read counts with
 * SUM(_sample_interval), never COUNT()
 * (developers.cloudflare.com/analytics/analytics-engine/sql-api/, read
 * 2026-10-14). The index is the event name, so a flood of request events is
 * sampled before the sign-in events.
 */
import type { AuthEvent, EventName, ObserveSink } from "@authtempo/core/observe";

/**
 * The blob order of each data point. A query reads blob1 as `name`, blob2 as
 * `route`, and so on, so a new field goes at the end and never between two.
 */
export const AE_BLOBS = [
  "name",
  "route",
  "outcome",
  "code",
  "method",
  "provider",
  "family",
  "traceId",
] as const;

/**
 * The most data points that one flush writes. Analytics Engine takes at most
 * 250 data points for each Worker invocation
 * (developers.cloudflare.com/analytics/analytics-engine/limits/, read
 * 2026-10-21). 200 leaves room for the app's own points in the same request.
 */
export const AE_MAX_POINTS = 200;

/**
 * The events that the sink writes by default: the counts that an operator
 * asks for (spec 31). The names join `EVENTS` in plan 12h Tasks 4 to 7.
 */
export const AE_DEFAULT_EVENTS: readonly string[] = [
  "request",
  "sign_in",
  "second_factor.challenge",
  "limit.hit",
  "sweep",
];

/** The part of an Analytics Engine binding that the sink calls. */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(p: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

export interface AnalyticsEngineOptions {
  /** The events to write. Default `AE_DEFAULT_EVENTS`. */
  events?: readonly EventName[];
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number => (typeof value === "number" ? value : 0);

/** The data point of one event: 1 for the count, then the duration and the status. */
function point(event: AuthEvent): {
  indexes: string[];
  blobs: (string | null)[];
  doubles: number[];
} {
  return {
    indexes: [event.name],
    blobs: AE_BLOBS.map((field) => text(event[field])),
    doubles: [1, number(event.durationMs), number(event.status)],
  };
}

/**
 * The sink. `writeDataPoint` does not block and is not awaited. Over
 * `AE_MAX_POINTS` in one batch, the sink writes the first 200 and throws a
 * `RangeError` that names the rest, so the observer counts the batch in
 * `sink_threw` and the loss is never silent.
 */
export function analyticsEngineSink(
  dataset: AnalyticsEngineDatasetLike,
  options: AnalyticsEngineOptions = {},
): ObserveSink {
  const chosen: ReadonlySet<string> = new Set<string>(options.events ?? AE_DEFAULT_EVENTS);
  return {
    write(batch) {
      let written = 0;
      let dropped = 0;
      for (const event of batch) {
        if (!chosen.has(event.name)) continue;
        if (written >= AE_MAX_POINTS) {
          dropped += 1;
          continue;
        }
        dataset.writeDataPoint(point(event));
        written += 1;
      }
      if (dropped > 0)
        throw new RangeError(
          `analyticsEngineSink: ${dropped} events dropped over the cap of ${AE_MAX_POINTS} data points for each flush`,
        );
    },
  };
}
