import { type AuthEvent, EVENTS } from "@authtempo/core/observe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregate, HTTP_DURATION_BUCKETS, METRICS, type MetricPoint } from "../src/metrics.js";
import { otlpSink } from "../src/otlp.js";
import { built } from "./events.js";

/**
 * One source event for each row of `METRICS`. The names of plan 12h Task 7
 * have no row in `EVENTS` yet, so their fields are the ones of spec 31.
 * Each flow event carries the ids that its row holds, so a metric that
 * copies one shows here. The sign_in row holds the user and session ids
 * since Task 5. The request row holds the user id since plan 12n.
 */
const IDS = { userId: "usr_0123456789", sessionId: "ses_0123456789" };
const SOURCES: Readonly<Record<string, AuthEvent>> = {
  request: built("request", "info", {
    route: "POST /password/sign-in",
    method: "POST",
    status: 200,
    outcome: "ok",
    durationMs: 30,
    userId: IDS.userId,
  }),
  sign_in: built("sign_in", "info", { method: "password", outcome: "success", ...IDS }),
  "second_factor.challenge": built("second_factor.challenge", "info", {
    method: "totp",
    outcome: "failure",
    code: "invalid_code",
    userId: IDS.userId,
  }),
  "limit.hit": built("limit.hit", "warn", { family: "magic-link:email" }),
  // Every count of the core row, as a real sweep emits them (plan 12h Task 6): sessions 4, the rest 0.
  sweep: built("sweep", "info", {
    ...Object.fromEntries(
      Object.keys(EVENTS.sweep.fields)
        .filter((k) => k !== "durationMs")
        .map((k) => [k, k === "sessions" ? 4 : 0]),
    ),
    durationMs: 250,
  }),
  "observe.dropped": built("observe.dropped", "warn", {
    buffer_full: 2,
    sink_timeout: 0,
    sink_threw: 5,
  }),
};

const only = (points: MetricPoint[], name: string) => points.filter((p) => p.name === name);

/** The interval that the sink gives to `aggregate`: 10 s before the events to 1 s after. */
const FROM = 1792576790000;
const TO = 1792576801000;
const pointsOf = (batch: readonly AuthEvent[]) => aggregate(batch, FROM, TO);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the metrics of the OTLP sink", () => {
  it("derives each metric of the table from its event", () => {
    expect(METRICS.map((m) => [m.name, m.kind, m.unit, m.source])).toEqual([
      ["http.server.request.duration", "histogram", "s", "request"],
      ["authtempo.requests", "sum", "{request}", "request"],
      ["authtempo.sign_in", "sum", "{sign_in}", "sign_in"],
      ["authtempo.second_factor", "sum", "{challenge}", "second_factor.challenge"],
      ["authtempo.limit.hits", "sum", "{hit}", "limit.hit"],
      ["authtempo.sweep.rows", "sum", "{row}", "sweep"],
      ["authtempo.sweep.duration", "histogram", "s", "sweep"],
      ["authtempo.events.dropped", "sum", "{event}", "observe.dropped"],
    ]);
    for (const spec of METRICS) {
      const source = SOURCES[spec.source];
      if (source === undefined) throw new Error(`no source event for ${spec.name}`);
      // Two events of the source: one point, counted twice. Another event gives nothing.
      const points = only(pointsOf([source, source, SOURCES["limit.hit"] as AuthEvent]), spec.name);
      expect(points.length).toBeGreaterThan(0);
      for (const p of points) {
        expect([p.kind, p.unit]).toEqual([spec.kind, spec.unit]);
        if (p.kind === "histogram") expect(p.count).toBe(2);
      }
    }
    const all = pointsOf(Object.values(SOURCES));
    expect(only(all, "authtempo.sign_in")).toMatchObject([
      { kind: "sum", value: 1, attributes: { method: "password", outcome: "success" } },
    ]);
    expect(only(all, "authtempo.limit.hits")).toMatchObject([
      { value: 1, attributes: { family: "magic-link:email" } },
    ]);
    // A count of 0 gives no point.
    expect(only(all, "authtempo.sweep.rows")).toMatchObject([
      { value: 4, attributes: { kind: "sessions" } },
    ]);
    expect(only(all, "authtempo.events.dropped")).toMatchObject([
      { value: 2, attributes: { reason: "buffer_full" } },
      { value: 5, attributes: { reason: "sink_threw" } },
    ]);
    // Another attribute set is another point.
    const failed = {
      ...SOURCES.sign_in,
      outcome: "failure",
      code: "invalid_credentials",
    } as AuthEvent;
    expect(
      only(pointsOf([SOURCES.sign_in as AuthEvent, failed]), "authtempo.sign_in"),
    ).toHaveLength(2);
  });

  it("writes each sum and histogram with delta temporality", async () => {
    const sent: unknown[] = [];
    const fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;
    // The sink is made at FROM and flushes at TO.
    const now = vi.spyOn(Date, "now").mockReturnValue(FROM);
    const sink = otlpSink({
      endpoint: "https://c.example.test",
      serviceName: "auth",
      signals: ["metrics"],
      fetch,
    });
    now.mockReturnValue(TO);
    await sink.write(Object.values(SOURCES));
    // biome-ignore lint/suspicious/noExplicitAny: the test reads the JSON body by its OTLP field names.
    const metrics = (sent[0] as any).resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.map((m: { name: string }) => m.name)).toEqual(METRICS.map((m) => m.name));
    for (const m of metrics) {
      const data = m.sum ?? m.histogram;
      expect(data.aggregationTemporality).toBe(1);
      if (m.sum) expect(m.sum.isMonotonic).toBe(true);
    }
    const duration = metrics[0].histogram.dataPoints[0];
    expect(duration).toEqual({
      attributes: [
        { key: "http.request.method", value: { stringValue: "POST" } },
        { key: "http.route", value: { stringValue: "/password/sign-in" } },
        { key: "http.response.status_code", value: { intValue: "200" } },
      ],
      startTimeUnixNano: "1792576790000000000",
      timeUnixNano: "1792576801000000000",
      count: "1",
      sum: 0.03,
      bucketCounts: ["0", "0", "0", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
      explicitBounds: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
    });
    expect(metrics[1].sum.dataPoints[0].asInt).toBe("1");
  });

  it("gives each point the interval of the sink, not the times of its events", () => {
    const early = { ...SOURCES["limit.hit"], at: "2026-10-21T09:59:59.000Z" } as AuthEvent;
    const late = { ...SOURCES["limit.hit"], at: "2026-10-21T10:00:00.500Z" } as AuthEvent;
    const all = aggregate([early, late, SOURCES.request as AuthEvent], 1000, 2000);
    expect(all.length).toBeGreaterThan(1);
    for (const p of all) expect([p.startUnixMs, p.endUnixMs]).toEqual([1000, 2000]);
  });

  it("splits the drops by each count field of the observe.dropped row", () => {
    // Each field of the row in EVENTS, so a field that core adds gives a reason here with no edit.
    const fields = Object.keys(EVENTS["observe.dropped"].fields);
    expect(fields).toContain("buffer_full");
    for (const field of fields) {
      const counts = Object.fromEntries(fields.map((f) => [f, f === field ? 7 : 0]));
      const event = built("observe.dropped", "warn", counts);
      expect(only(pointsOf([event]), "authtempo.events.dropped")).toMatchObject([
        { value: 7, attributes: { reason: field } },
      ]);
    }
  });

  it("uses the stable bucket list for the request duration, in seconds", () => {
    expect(HTTP_DURATION_BUCKETS).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
    ]);
    const at = (durationMs: number) => ({ ...SOURCES.request, durationMs }) as AuthEvent;
    const [p] = only(pointsOf([at(30), at(50), at(10_001)]), "http.server.request.duration");
    if (p?.kind !== "histogram") throw new Error("no histogram point");
    expect(p.count).toBe(3);
    expect(p.sum).toBeCloseTo(10.081);
    // 30 ms and 50 ms fall into the bucket of 0.05; 10.001 s into the last, over 10.
    const bucket005 = HTTP_DURATION_BUCKETS.indexOf(0.05);
    expect(bucket005).toBe(3);
    expect(p.bucketCounts[bucket005]).toBe(2);
    expect(p.bucketCounts[HTTP_DURATION_BUCKETS.length]).toBe(1);
    expect(p.bucketCounts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("writes _OTHER for a method outside RFC 9110, and no route for an unmatched path", () => {
    const odd = { ...SOURCES.request, method: "BREW", route: "unmatched" } as AuthEvent;
    const [p] = only(pointsOf([odd]), "http.server.request.duration");
    expect(p?.attributes).toEqual({
      "http.request.method": "_OTHER",
      "http.response.status_code": 200,
    });
  });

  it("holds no user id in an attribute", () => {
    const banned = ["user.id", "userId", "sessionId", "ip", "ipHash", "userAgent", "emailHash"];
    for (const spec of METRICS)
      for (const key of spec.attributes) expect(banned).not.toContain(key);
    const points = pointsOf(Object.values(SOURCES));
    expect(points.length).toBeGreaterThanOrEqual(METRICS.length);
    for (const p of points) {
      for (const key of Object.keys(p.attributes)) expect(banned).not.toContain(key);
      for (const value of Object.values(p.attributes)) {
        expect(value).not.toBe(IDS.userId);
        expect(value).not.toBe(IDS.sessionId);
      }
    }
  });
});
