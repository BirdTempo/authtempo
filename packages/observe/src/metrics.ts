/**
 * The metrics of the OTLP sink (plan 12h, spec 31 item 11). Core holds no
 * metric. This file derives each metric from the events of one batch, so one
 * flush gives one delta point for each metric and attribute set.
 *
 * On Workers the clock moves only at I/O
 * (developers.cloudflare.com/workers/reference/security-model/, read
 * 2026-10-14). A duration there is the I/O time of the request, not its CPU
 * time.
 */
import type { AuthEvent } from "@authtempo/core/observe";

/**
 * The bucket bounds of `http.server.request.duration`, in seconds: the
 * advisory list of the stable HTTP semantic convention
 * (opentelemetry.io/docs/specs/semconv/http/http-metrics/, read 2026-10-21).
 * The sweep duration uses the same list.
 */
export const HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

export type MetricAttributes = Readonly<Record<string, string | number>>;

/** One value of one event for one metric. */
export interface Sample {
  attributes: MetricAttributes;
  value: number;
}

/** One row of `METRICS`: the table of spec 31 item 11. */
export interface MetricSpec {
  readonly name: string;
  readonly kind: "sum" | "histogram";
  readonly unit: string;
  readonly description: string;
  /** The event that gives the samples. */
  readonly source: string;
  /** Each attribute key that a sample can hold. No key holds a user id. */
  readonly attributes: readonly string[];
  /** The samples of one source event. */
  samples(event: AuthEvent): readonly Sample[];
}

interface PointBase {
  readonly name: string;
  readonly unit: string;
  readonly description: string;
  readonly attributes: MetricAttributes;
  /** The time of the first and of the last event of the point, in ms since the epoch. */
  readonly startUnixMs: number;
  readonly endUnixMs: number;
}

/** One delta point: a monotonic sum, or a histogram of `HTTP_DURATION_BUCKETS`. */
export type MetricPoint =
  | (PointBase & { readonly kind: "sum"; readonly value: number })
  | (PointBase & {
      readonly kind: "histogram";
      readonly count: number;
      readonly sum: number;
      readonly bucketCounts: readonly number[];
      readonly explicitBounds: readonly number[];
    });

type Reader = (event: AuthEvent) => string | number | undefined;

const field =
  (name: string): Reader =>
  (event) => {
    const value = event[name];
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  };

/**
 * The methods of RFC 9110 and PATCH. The semantic convention writes `_OTHER`
 * for any other method. A client picks the method, so a free token in an
 * attribute gives a new series for each request.
 */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

const httpMethod: Reader = (event) => {
  const method = event.method;
  if (typeof method !== "string") return undefined;
  return KNOWN_METHODS.has(method) ? method : "_OTHER";
};

/** The path template of a route key, `POST /password/sign-in` to `/password/sign-in`. */
const httpRoute: Reader = (event) => {
  const route = event.route;
  if (typeof route !== "string" || route === "unmatched") return undefined;
  const space = route.indexOf(" ");
  return space === -1 ? undefined : route.slice(space + 1);
};

function attributesOf(
  event: AuthEvent,
  readers: Readonly<Record<string, Reader>>,
): MetricAttributes {
  const out: Record<string, string | number> = {};
  for (const [key, read] of Object.entries(readers)) {
    const value = read(event);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A monotonic sum that counts 1 for each source event. */
function counted(
  name: string,
  unit: string,
  description: string,
  source: string,
  readers: Readonly<Record<string, Reader>>,
): MetricSpec {
  return {
    name,
    kind: "sum",
    unit,
    description,
    source,
    attributes: Object.keys(readers),
    samples: (event) => [{ attributes: attributesOf(event, readers), value: 1 }],
  };
}

/** A histogram in seconds of the `durationMs` field of each source event. */
function timed(
  name: string,
  description: string,
  source: string,
  readers: Readonly<Record<string, Reader>>,
): MetricSpec {
  return {
    name,
    kind: "histogram",
    unit: "s",
    description,
    source,
    attributes: Object.keys(readers),
    samples: (event) =>
      typeof event.durationMs === "number"
        ? [{ attributes: attributesOf(event, readers), value: event.durationMs / 1000 }]
        : [],
  };
}

/**
 * A monotonic sum of each count field of the source event, with the field
 * name in one attribute. A count of 0 gives no sample.
 */
function split(
  name: string,
  unit: string,
  description: string,
  source: string,
  key: string,
  counts: (event: AuthEvent) => readonly string[],
): MetricSpec {
  return {
    name,
    kind: "sum",
    unit,
    description,
    source,
    attributes: [key],
    samples: (event) =>
      counts(event).flatMap((f) => {
        const value = event[f];
        return typeof value === "number" && value > 0 ? [{ attributes: { [key]: f }, value }] : [];
      }),
  };
}

/**
 * The count fields of a sweep event: one for each key of `SweepResult` (plan
 * 12h Task 6). Each number field other than `durationMs` is a count, so a new
 * key of `SweepResult` needs no edit here.
 */
const sweepCounts = (event: AuthEvent): readonly string[] =>
  Object.keys(event).filter((k) => k !== "durationMs" && typeof event[k] === "number");

/** The three drop counts of `observe.dropped` (spec 31 item 4). */
const DROP_COUNTS: readonly string[] = ["buffer_full", "sink_timeout", "sink_threw"];

/**
 * The metrics of spec 31 item 11. The source events and their fields are the
 * ones of spec 31 and plan 12h Tasks 4 to 7. No attribute holds a user id, a
 * session id, or an address.
 */
export const METRICS: readonly MetricSpec[] = [
  timed("http.server.request.duration", "The duration of each answer of handle.", "request", {
    "http.request.method": httpMethod,
    "http.route": httpRoute,
    "http.response.status_code": field("status"),
  }),
  counted("authtempo.requests", "{request}", "The answers of handle.", "request", {
    route: field("route"),
    outcome: field("outcome"),
    code: field("code"),
  }),
  counted("authtempo.sign_in", "{sign_in}", "The sign-in acts.", "sign_in", {
    method: field("method"),
    provider: field("provider"),
    outcome: field("outcome"),
    code: field("code"),
  }),
  counted(
    "authtempo.second_factor",
    "{challenge}",
    "The second factor challenges.",
    "second_factor.challenge",
    { method: field("method"), outcome: field("outcome"), code: field("code") },
  ),
  counted("authtempo.limit.hits", "{hit}", "The refusals of a limit.", "limit.hit", {
    family: field("family"),
  }),
  split(
    "authtempo.sweep.rows",
    "{row}",
    "The rows that a sweep deleted.",
    "sweep",
    "kind",
    sweepCounts,
  ),
  timed("authtempo.sweep.duration", "The duration of each sweep.", "sweep", {}),
  split(
    "authtempo.events.dropped",
    "{event}",
    "The events that the observer lost.",
    "observe.dropped",
    "reason",
    () => DROP_COUNTS,
  ),
];

/** The time of an event in ms since the epoch. */
const timeOf = (event: AuthEvent): number => Date.parse(event.at);

/** The index of the bucket of a value: bucket i holds the values over bound i-1 and at most bound i. */
function bucketOf(value: number, bounds: readonly number[]): number {
  const i = bounds.findIndex((bound) => value <= bound);
  return i === -1 ? bounds.length : i;
}

/** Sorted keys, so one attribute set gives one point whatever the field order. */
function keyOf(name: string, attributes: MetricAttributes): string {
  const sorted = Object.keys(attributes)
    .sort()
    .map((k) => [k, attributes[k]]);
  return JSON.stringify([name, sorted]);
}

/** The running total of one point while the batch is read. */
interface Total {
  readonly spec: MetricSpec;
  readonly attributes: MetricAttributes;
  start: number;
  end: number;
  count: number;
  sum: number;
  readonly buckets: number[];
}

function pointOf(t: Total): MetricPoint {
  const base = {
    name: t.spec.name,
    unit: t.spec.unit,
    description: t.spec.description,
    attributes: t.attributes,
    startUnixMs: t.start,
    endUnixMs: t.end,
  };
  return t.spec.kind === "sum"
    ? { ...base, kind: "sum", value: t.sum }
    : {
        ...base,
        kind: "histogram",
        count: t.count,
        sum: t.sum,
        bucketCounts: t.buckets,
        explicitBounds: HTTP_DURATION_BUCKETS,
      };
}

/**
 * The delta points of one batch: one for each metric and attribute set. A
 * point covers the time from its first event to its last.
 */
export function aggregate(batch: readonly AuthEvent[]): MetricPoint[] {
  const totals = new Map<string, Total>();
  for (const event of batch)
    for (const spec of METRICS) {
      if (event.name !== spec.source) continue;
      const at = timeOf(event);
      for (const { attributes, value } of spec.samples(event)) {
        const key = keyOf(spec.name, attributes);
        let t = totals.get(key);
        if (t === undefined) {
          const buckets = new Array<number>(HTTP_DURATION_BUCKETS.length + 1).fill(0);
          t = { spec, attributes, start: at, end: at, count: 0, sum: 0, buckets };
          totals.set(key, t);
        }
        t.start = Math.min(t.start, at);
        t.end = Math.max(t.end, at);
        t.count += 1;
        t.sum += value;
        const i = bucketOf(value, HTTP_DURATION_BUCKETS);
        t.buckets[i] = (t.buckets[i] ?? 0) + 1;
      }
    }
  return [...totals.values()].map(pointOf);
}
