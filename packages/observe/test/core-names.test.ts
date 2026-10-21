import { createAuth, createMemoryAdapter } from "@authtempo/core";
import {
  type AuthEvent,
  EVENTS,
  type EventName,
  type ObserveSink,
  STAMP_FIELDS,
} from "@authtempo/core/observe";
import { describe, expect, it } from "vitest";
import {
  AE_BLOBS,
  AE_DEFAULT_EVENTS,
  AE_DOUBLES,
  analyticsEngineSink,
} from "../src/analytics-engine.js";
import { METRICS } from "../src/metrics.js";

/**
 * The names that this package reads from the events of core (rulings 11 and
 * 15 of plan 12h). A name that core does not emit gives an empty blob or an
 * empty metric with no error. So this test holds each name to `EVENTS`.
 */

function authWith(sink: ObserveSink, trustTraceparent = false) {
  return createAuth({
    baseURL: "https://api.example.test",
    secret: "kP9vQ2xL7mN4rT8wZ1yB6cF3hJ5sD0gA",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    observe: { sink, trustTraceparent },
  });
}

const health = (headers: HeadersInit = {}) =>
  new Request("https://api.example.test/auth/health", { headers });

/** The keys that the observer stamps on each event of a request, read from a real event. */
async function stampKeys(traceparent?: string): Promise<Set<string>> {
  const seen: AuthEvent[] = [];
  const auth = authWith({ write: (b) => void seen.push(...b) }, traceparent !== undefined);
  const headers: HeadersInit = traceparent === undefined ? {} : { traceparent };
  expect((await auth.handle(health(headers))).status).toBe(200);
  await auth.observe.flush();
  const request = seen.find((e) => e.name === "request");
  expect(request).toBeDefined();
  const own = new Set(Object.keys(EVENTS.request.fields));
  return new Set(Object.keys(request ?? {}).filter((k) => !own.has(k)));
}

const known = (name: string): name is EventName => Object.hasOwn(EVENTS, name);

describe("the names of core in the sinks", () => {
  it("names only events of core in AE_DEFAULT_EVENTS", () => {
    expect(AE_DEFAULT_EVENTS.length).toBeGreaterThan(0);
    expect(AE_DEFAULT_EVENTS.filter((name) => !known(name))).toEqual([]);
  });

  it("names only a stamp or a field of a default event in AE_BLOBS", async () => {
    const stamps = await stampKeys();
    expect([...stamps].sort()).toEqual(["at", "level", "name", "route", "spanId", "traceId"]);
    const fields = new Set(
      AE_DEFAULT_EVENTS.filter(known).flatMap((name) => Object.keys(EVENTS[name].fields)),
    );
    expect(AE_BLOBS.filter((f) => !stamps.has(f) && !fields.has(f))).toEqual([]);
  });

  it("holds STAMP_FIELDS to the stamp of a real event with a parent span", async () => {
    const stamp = ["at", "level", "name", "parentSpanId", "route", "spanId", "traceId"];
    const stamps = await stampKeys("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect([...stamps].sort()).toEqual(stamp);
    expect([...STAMP_FIELDS].sort()).toEqual(stamp);
  });

  it("names only a number field of a default event in AE_DOUBLES", () => {
    expect([...AE_DOUBLES]).toEqual(["durationMs", "status"]);
    const kinds = new Map<string, string>();
    for (const name of AE_DEFAULT_EVENTS.filter(known))
      for (const [field, spec] of Object.entries(EVENTS[name].fields)) kinds.set(field, spec.kind);
    expect(AE_DOUBLES.map((field) => [field, kinds.get(field)])).toEqual([
      ["durationMs", "durationMs"],
      ["status", "status"],
    ]);
  });

  it("reads only a stamp or a field of its source event in each metric", async () => {
    const stamps = await stampKeys();
    expect(METRICS.filter((m) => !known(m.source)).map((m) => m.name)).toEqual([]);
    for (const metric of METRICS) {
      if (!known(metric.source)) continue;
      const fields = Object.keys(EVENTS[metric.source].fields);
      // Each field holds a value, so a reader reaches every field that it names.
      const base: Record<string, unknown> = {
        name: metric.source,
        level: EVENTS[metric.source].level,
        at: "2026-10-21T10:00:00.000Z",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        route: "GET /health",
        ...Object.fromEntries(fields.map((f) => [f, 1])),
      };
      const read = new Set<string>();
      const event = new Proxy(base, {
        get(target, key, receiver) {
          if (typeof key === "string") read.add(key);
          return Reflect.get(target, key, receiver);
        },
      }) as AuthEvent;
      metric.samples(event);
      const unknown = [...read].filter((k) => !stamps.has(k) && !fields.includes(k));
      expect({ metric: metric.name, unknown }).toEqual({ metric: metric.name, unknown: [] });
    }
  });

  it("counts a batch that the Analytics Engine sink refuses in the next observe.dropped", async () => {
    // A real Auth and a real observer: 201 request events pass the cap of 200 points.
    const points: { indexes?: string[] }[] = [];
    const batches: AuthEvent[][] = [];
    const ae = analyticsEngineSink({ writeDataPoint: (p) => void points.push(p) });
    const auth = authWith({
      write(batch) {
        batches.push([...batch]);
        return ae.write(batch);
      },
    });
    for (let i = 0; i < 201; i++) await auth.handle(health());
    await auth.observe.flush();
    expect(points).toHaveLength(200);
    // The count holds the 200 written points too, as the README states (ruling 31, Low 3).
    expect(auth.observe.stats().dropped).toEqual({
      buffer_full: 0,
      sink_timeout: 0,
      sink_threw: 201,
    });
    await auth.handle(health());
    await auth.observe.flush();
    const [head] = batches[1] ?? [];
    expect(head).toMatchObject({
      name: "observe.dropped",
      buffer_full: 0,
      sink_timeout: 0,
      sink_threw: 201,
    });
    expect(points.slice(200).map((p) => p.indexes)).toEqual([["observe.dropped"], ["request"]]);
    expect(auth.observe.stats().dropped.sink_threw).toBe(0);
  });
});
