/**
 * The OTLP JSON bodies of the OTLP sink (plan 12h, spec 31 item 13). The
 * field names are those of opentelemetry-proto v1.11.0 in lower camel case
 * (read 2026-10-21; the list is in the plan 12h Task 11 notes). The rules of
 * OTLP JSON are in docs/specification.md, "JSON Protobuf Encoding". A trace id
 * and a span id are hex. An enum is an integer. A 64-bit integer is a decimal
 * string.
 */
import type { AuthEvent } from "@authtempo/core/observe";
import type { MetricAttributes, MetricPoint } from "./metrics.js";

/** SeverityNumber of logs.proto for each level of an event. */
export const SEVERITY_NUMBER = { info: 9, warn: 13, error: 17 } as const;
const SEVERITY_TEXT = { info: "INFO", warn: "WARN", error: "ERROR" } as const;
/** SpanKind SPAN_KIND_SERVER of trace.proto. */
export const SPAN_KIND_SERVER = 2;
/** StatusCode of trace.proto. */
export const STATUS_CODE_UNSET = 0;
export const STATUS_CODE_ERROR = 2;
/** AggregationTemporality AGGREGATION_TEMPORALITY_DELTA of metrics.proto. */
export const AGGREGATION_TEMPORALITY_DELTA = 1;

/**
 * The event of one answer of handle. A string, not an `EventName`: the event
 * joins `EVENTS` in plan 12h Task 4.
 */
const REQUEST: string = "request";

/** The instrumentation scope of every body. */
const SCOPE = { name: "@authtempo/observe" } as const;

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } };

interface KeyValue {
  key: string;
  value: AnyValue;
}

/** The fields of an event that a log record or a span holds in its own fields. */
const OWN_FIELDS: ReadonlySet<string> = new Set(["name", "level", "at", "traceId", "spanId"]);

/** A time in ms since the epoch as fixed64 nanoseconds: a decimal string. */
export function unixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function anyValue(value: unknown): AnyValue | undefined {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return { intValue: String(value) };
    return Number.isFinite(value) ? { doubleValue: value } : undefined;
  }
  if (Array.isArray(value)) {
    const values = value.map(anyValue).filter((v) => v !== undefined);
    return { arrayValue: { values } };
  }
  return undefined;
}

function keyValues(entries: Iterable<[string, unknown]>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [key, raw] of entries) {
    const value = anyValue(raw);
    if (value !== undefined) out.push({ key, value });
  }
  return out;
}

/** Each field of an event, other than the ones that the record holds itself, as an attribute. */
function eventAttributes(event: AuthEvent): KeyValue[] {
  return keyValues(Object.entries(event).filter(([key]) => !OWN_FIELDS.has(key)));
}

const levelOf = (event: AuthEvent): keyof typeof SEVERITY_NUMBER =>
  Object.hasOwn(SEVERITY_NUMBER, event.level) ? event.level : "error";

const timeOf = (event: AuthEvent): number => Date.parse(event.at);

function resource(serviceName: string) {
  return { attributes: keyValues([["service.name", serviceName]]) };
}

/** `ExportLogsServiceRequest`: one log record for each event. Null for an empty batch. */
export function logsBody(batch: readonly AuthEvent[], serviceName: string) {
  if (batch.length === 0) return null;
  const logRecords = batch.map((event) => {
    const level = levelOf(event);
    return {
      timeUnixNano: unixNano(timeOf(event)),
      severityNumber: SEVERITY_NUMBER[level],
      severityText: SEVERITY_TEXT[level],
      eventName: event.name,
      body: { stringValue: event.name },
      attributes: eventAttributes(event),
      traceId: event.traceId,
      spanId: event.spanId,
    };
  });
  return {
    resourceLogs: [{ resource: resource(serviceName), scopeLogs: [{ scope: SCOPE, logRecords }] }],
  };
}

/**
 * `ExportTraceServiceRequest`: one server span for each `request` event. The
 * span ends at `at` and starts `durationMs` before. The other events of its
 * trace are span events. An `error` event of the trace or a 5xx status sets
 * the status ERROR. Null when the batch holds no `request` event.
 */
export function tracesBody(batch: readonly AuthEvent[], serviceName: string) {
  const requests = batch.filter((e) => e.name === REQUEST);
  if (requests.length === 0) return null;
  const spans = requests.map((request) => {
    const end = timeOf(request);
    const duration = typeof request.durationMs === "number" ? request.durationMs : 0;
    const others = batch.filter((e) => e !== request && e.traceId === request.traceId);
    const failed =
      (typeof request.status === "number" && request.status >= 500) ||
      others.some((e) => levelOf(e) === "error");
    return {
      traceId: request.traceId,
      spanId: request.spanId,
      ...(typeof request.parentSpanId === "string" ? { parentSpanId: request.parentSpanId } : {}),
      name: typeof request.route === "string" ? request.route : "unmatched",
      kind: SPAN_KIND_SERVER,
      startTimeUnixNano: unixNano(end - duration),
      endTimeUnixNano: unixNano(end),
      attributes: eventAttributes(request).filter((a) => a.key !== "parentSpanId"),
      events: others.map((e) => ({
        timeUnixNano: unixNano(timeOf(e)),
        name: e.name,
        attributes: eventAttributes(e),
      })),
      status: { code: failed ? STATUS_CODE_ERROR : STATUS_CODE_UNSET },
    };
  });
  return {
    resourceSpans: [{ resource: resource(serviceName), scopeSpans: [{ scope: SCOPE, spans }] }],
  };
}

const metricAttributes = (attributes: MetricAttributes): KeyValue[] =>
  keyValues(Object.entries(attributes));

/** `ExportMetricsServiceRequest`: one metric for each name, one data point for each attribute set. */
export function metricsBody(points: readonly MetricPoint[], serviceName: string) {
  if (points.length === 0) return null;
  const byName = new Map<string, MetricPoint[]>();
  for (const p of points) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  const metrics = [...byName.values()].map((group) => {
    const [first] = group as [MetricPoint, ...MetricPoint[]];
    const head = { name: first.name, description: first.description, unit: first.unit };
    if (first.kind === "sum")
      return {
        ...head,
        sum: {
          dataPoints: group.map((p) => ({
            attributes: metricAttributes(p.attributes),
            startTimeUnixNano: unixNano(p.startUnixMs),
            timeUnixNano: unixNano(p.endUnixMs),
            asInt: String(p.kind === "sum" ? p.value : 0),
          })),
          aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
          isMonotonic: true,
        },
      };
    return {
      ...head,
      histogram: {
        dataPoints: group.flatMap((p) =>
          p.kind === "histogram"
            ? [
                {
                  attributes: metricAttributes(p.attributes),
                  startTimeUnixNano: unixNano(p.startUnixMs),
                  timeUnixNano: unixNano(p.endUnixMs),
                  count: String(p.count),
                  sum: p.sum,
                  bucketCounts: p.bucketCounts.map(String),
                  explicitBounds: [...p.explicitBounds],
                },
              ]
            : [],
        ),
        aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
      },
    };
  });
  return {
    resourceMetrics: [
      { resource: resource(serviceName), scopeMetrics: [{ scope: SCOPE, metrics }] },
    ],
  };
}
