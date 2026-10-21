import { createAuth, createMemoryAdapter, type StorageAdapter } from "@authtempo/core";
import type { AuthEvent, ObserveSink } from "@authtempo/core/observe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { otlpSink } from "../src/otlp.js";
import { built } from "./events.js";

const ENDPOINT = "https://collector.example.test";
const AT_NANO = "1792576800000000000";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Sent {
  url: string;
  init: RequestInit;
  // biome-ignore lint/suspicious/noExplicitAny: the test reads the JSON body by its OTLP field names.
  body: any;
}

/**
 * A fake fetch that records each request and answers with `answer`. It
 * follows a redirect as fetch does, unless the request says `manual`.
 */
function recorder(answer: (url: string) => Response | Promise<Response> = () => ok()) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    sent.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const res = await answer(url);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null && init?.redirect !== "manual")
      return fetch(location, init);
    return res;
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

/** The log records of a logs post. */
function logRecords(sent: Sent | undefined) {
  if (sent === undefined) throw new Error("no post");
  return sent.body.resourceLogs[0].scopeLogs[0].logRecords;
}

const ok = () => new Response(null, { status: 200 });

const request = built("request", "info", {
  route: "POST /password/sign-in",
  method: "POST",
  status: 500,
  outcome: "server_error",
  code: "internal",
  durationMs: 120,
});
const internal = built("error.internal", "error", {
  method: "POST",
  route: "POST /password/sign-in",
  errorName: "TypeError",
});
const dropped = built("observe.dropped", "warn", {
  buffer_full: 3,
  sink_timeout: 0,
  sink_threw: 0,
});

/** A memory store whose `findOne` throws: a store that is down, so a session read answers 500. */
function downStore(): StorageAdapter {
  return {
    ...createMemoryAdapter(),
    findOne: async () => {
      throw new TypeError("db down");
    },
  };
}

const sessionRead = () =>
  new Request("https://api.example.test/auth/session", {
    headers: { authorization: `Bearer ts_${"a".repeat(43)}` },
  });

/** A real Auth with the sink. A session read on the down store emits one error.internal event. */
function authWith(sink: ObserveSink, flushTimeoutMs?: number) {
  return createAuth({
    baseURL: "https://api.example.test",
    secret: "kP9vQ2xL7mN4rT8wZ1yB6cF3hJ5sD0gA",
    trustedOrigins: [],
    storage: downStore(),
    mail: { send: async () => {} },
    observe: { sink, ...(flushTimeoutMs === undefined ? {} : { flushTimeoutMs }) },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("otlpSink", () => {
  it("posts each signal to its path as JSON", async () => {
    const r = recorder();
    const sink = otlpSink({
      endpoint: `${ENDPOINT}/`,
      serviceName: "auth",
      headers: { "x-api-key": "key-0123456789" },
      fetch: r.fetch,
    });
    await sink.write([request, internal]);
    expect(r.sent.map((s) => s.url)).toEqual([
      `${ENDPOINT}/v1/logs`,
      `${ENDPOINT}/v1/traces`,
      `${ENDPOINT}/v1/metrics`,
    ]);
    for (const s of r.sent) {
      expect(s.init.method).toBe("POST");
      expect(s.init.redirect).toBe("manual");
      const headers = new Headers(s.init.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-api-key")).toBe("key-0123456789");
    }
    expect(Object.keys(r.sent[0]?.body)).toEqual(["resourceLogs"]);
    expect(Object.keys(r.sent[1]?.body)).toEqual(["resourceSpans"]);
    expect(Object.keys(r.sent[2]?.body)).toEqual(["resourceMetrics"]);
    expect(r.sent[0]?.body.resourceLogs[0].resource).toEqual({
      attributes: [
        { key: "service.name", value: { stringValue: "auth" } },
        { key: "service.instance.id", value: { stringValue: expect.stringMatching(UUID) } },
      ],
    });
  });

  it("gives each sink its own service.instance.id, the same in each body and flush", async () => {
    const instanceOf = (body: Record<string, [{ resource: { attributes: unknown[] } }]>) => {
      const [resources] = Object.values(body);
      return resources?.[0].resource.attributes[1];
    };
    const a = recorder();
    const b = recorder();
    const sinkA = otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: a.fetch });
    const sinkB = otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: b.fetch });
    await sinkA.write([request]);
    await sinkA.write([request]);
    await sinkB.write([request]);
    const idsA = a.sent.map((s) => instanceOf(s.body));
    const idsB = b.sent.map((s) => instanceOf(s.body));
    expect(idsA).toHaveLength(6);
    expect(new Set(idsA.map((v) => JSON.stringify(v))).size).toBe(1);
    expect(new Set(idsB.map((v) => JSON.stringify(v))).size).toBe(1);
    expect(idsA[0]).not.toEqual(idsB[0]);
  });

  it("starts each delta point at the end of the last flush, the first at the sink creation", async () => {
    const r = recorder();
    const startEnd = (s: Sent | undefined) => {
      const [p] = s?.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints ?? [];
      return [p?.startTimeUnixNano, p?.timeUnixNano];
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(1792576790000);
    const sink = otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      signals: ["metrics"],
      fetch: r.fetch,
    });
    now.mockReturnValue(1792576801000);
    await sink.write([dropped]);
    now.mockReturnValue(1792576802000);
    await sink.write([dropped]);
    expect(r.sent.map(startEnd)).toEqual([
      ["1792576790000000000", "1792576801000000000"],
      ["1792576801000000000", "1792576802000000000"],
    ]);
    // A clock that does not move, as on Workers with no I/O: one event still gives start < end.
    const still = recorder();
    vi.spyOn(Date, "now").mockReturnValue(1792576800000);
    await otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      signals: ["metrics"],
      fetch: still.fetch,
    }).write([dropped]);
    expect(startEnd(still.sent[0])).toEqual(["1792576800000000000", "1792576800001000000"]);
    // The global scope of workerd reads 0: the first point starts at the first event.
    const global = recorder();
    const zero = vi.spyOn(Date, "now").mockReturnValue(0);
    const early = otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      signals: ["metrics"],
      fetch: global.fetch,
    });
    zero.mockReturnValue(1792576801000);
    await early.write([dropped]);
    expect(startEnd(global.sent[0])).toEqual(["1792576800000000000", "1792576801000000000"]);
  });

  it("aborts a post that outlives timeoutMs", async () => {
    const reasons: unknown[] = [];
    // A collector that never answers. The post ends only when its signal aborts.
    const fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reasons.push(init.signal?.reason);
          reject(init.signal?.reason);
        });
      })) as typeof globalThis.fetch;
    const sink = otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch, timeoutMs: 50 });
    const started = Date.now();
    await expect(sink.write([internal])).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reasons).toHaveLength(1);
    expect((reasons[0] as Error).name).toBe("TimeoutError");
    // The default is the default flushTimeoutMs of core.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: recorder().fetch }).write([
      internal,
    ]);
    expect(timeout).toHaveBeenCalledWith(2000);
  });

  it("keeps the kind-checked fields out of the scrub", async () => {
    const r = recorder();
    const limit = built("limit.hit", "warn", { family: "magic-link:email" });
    await otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      headers: { "x-scope-orgid": "limit" },
      fetch: r.fetch,
    }).write([{ ...limit, parentSpanId: "20f067aa0ba902b7" }]);
    const [record] = logRecords(r.sent[0]);
    expect(record.eventName).toBe("limit.hit");
    expect(record.traceId).toBe(TRACE);
    expect(record.spanId).toBe("00f067aa0ba902b7");
    expect(record.timeUnixNano).toBe(AT_NANO);
    expect(record.severityText).toBe("WARN");
    expect(record.attributes).toContainEqual({
      key: "parentSpanId",
      value: { stringValue: "20f067aa0ba902b7" },
    });
    expect(r.sent.map((s) => s.url)).toEqual([`${ENDPOINT}/v1/logs`, `${ENDPOINT}/v1/metrics`]);
    const metric = r.sent[1]?.body.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("authtempo.limit.hits");
  });

  it("writes one log record for each event", async () => {
    const r = recorder();
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch }).write([
      request,
      dropped,
      internal,
    ]);
    const records = logRecords(r.sent[0]);
    expect(records).toHaveLength(3);
    expect(records.map((l: { severityNumber: number }) => l.severityNumber)).toEqual([9, 13, 17]);
    expect(records[0]).toEqual({
      timeUnixNano: AT_NANO,
      severityNumber: 9,
      severityText: "INFO",
      eventName: "request",
      body: { stringValue: "request" },
      attributes: [
        { key: "route", value: { stringValue: "POST /password/sign-in" } },
        { key: "method", value: { stringValue: "POST" } },
        { key: "status", value: { intValue: "500" } },
        { key: "outcome", value: { stringValue: "server_error" } },
        { key: "code", value: { stringValue: "internal" } },
        { key: "durationMs", value: { intValue: "120" } },
      ],
      traceId: TRACE,
      spanId: "00f067aa0ba902b7",
    });
    const rejected = { ...internal, rejected: ["status"] };
    const one = recorder();
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: one.fetch }).write([rejected]);
    const [record] = logRecords(one.sent[0]);
    expect(record.attributes).toContainEqual({
      key: "rejected",
      value: { arrayValue: { values: [{ stringValue: "status" }] } },
    });
  });

  it("writes one server span for each request event, with the other events as span events", async () => {
    const r = recorder();
    const other = { ...dropped, traceId: "0af7651916cd43dd8448eb211c80319c" };
    const { code: _code, ...noCode } = request;
    const quiet: AuthEvent = {
      ...noCode,
      traceId: "1af7651916cd43dd8448eb211c80319c",
      spanId: "10f067aa0ba902b7",
      parentSpanId: "20f067aa0ba902b7",
      status: 200,
      outcome: "ok",
      durationMs: 30,
    };
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch }).write([
      internal,
      request,
      other,
      quiet,
    ]);
    const spans = r.sent[1]?.body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({
      traceId: TRACE,
      spanId: "00f067aa0ba902b7",
      name: "POST /password/sign-in",
      kind: 2,
      startTimeUnixNano: "1792576799880000000",
      endTimeUnixNano: AT_NANO,
      attributes: [
        { key: "route", value: { stringValue: "POST /password/sign-in" } },
        { key: "method", value: { stringValue: "POST" } },
        { key: "status", value: { intValue: "500" } },
        { key: "outcome", value: { stringValue: "server_error" } },
        { key: "code", value: { stringValue: "internal" } },
        { key: "durationMs", value: { intValue: "120" } },
      ],
      events: [
        {
          timeUnixNano: AT_NANO,
          name: "error.internal",
          attributes: [
            { key: "method", value: { stringValue: "POST" } },
            { key: "route", value: { stringValue: "POST /password/sign-in" } },
            { key: "errorName", value: { stringValue: "TypeError" } },
          ],
        },
      ],
      status: { code: 2 },
    });
    // A request of another trace with no error event: its parent, no span event, and status UNSET.
    expect(spans[1]).toMatchObject({
      traceId: "1af7651916cd43dd8448eb211c80319c",
      spanId: "10f067aa0ba902b7",
      parentSpanId: "20f067aa0ba902b7",
      startTimeUnixNano: "1792576799970000000",
      events: [],
      status: { code: 0 },
    });
    // The 5xx status alone sets ERROR too.
    const alone = recorder();
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: alone.fetch }).write([
      request,
    ]);
    expect(alone.sent[1]?.body.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({ code: 2 });
  });

  it("writes 64-bit integers as decimal strings and enums as integers", async () => {
    const r = recorder();
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch }).write([
      request,
      internal,
      dropped,
    ]);
    const digits: unknown[] = [];
    const enums: unknown[] = [];
    const walk = (value: unknown, key: string): void => {
      if (Array.isArray(value)) {
        for (const v of value) walk(v, key);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, k);
        return;
      }
      if (key.endsWith("UnixNano") || key === "count" || key === "bucketCounts" || key === "asInt")
        digits.push(value);
      if (key === "kind" || key === "severityNumber" || key === "aggregationTemporality")
        enums.push(value);
    };
    for (const s of r.sent) walk(s.body, "");
    // 3 log times, 2 span times and 1 span event time, and the metric points.
    expect(digits.length).toBeGreaterThan(20);
    for (const d of digits) expect(d).toMatch(/^[0-9]+$/);
    expect(enums.length).toBeGreaterThan(5);
    for (const e of enums) expect(Number.isInteger(e)).toBe(true);
  });

  it("makes no retry inside a flush", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recorder(() => new Response("busy", { status: 503 }));
    const auth = authWith(otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch }));
    expect((await auth.handle(sessionRead())).status).toBe(500);
    await auth.observe.flush();
    // One error.internal event: a log record only, so one post, and no second one.
    expect(r.sent.map((s) => s.url)).toEqual([`${ENDPOINT}/v1/logs`]);
    expect(auth.observe.stats().dropped).toEqual({
      buffer_full: 0,
      sink_timeout: 0,
      sink_threw: 1,
    });
    // The next flush sends only the drop report, once.
    await auth.observe.flush();
    expect(r.sent.map((s) => s.url)).toEqual([
      `${ENDPOINT}/v1/logs`,
      `${ENDPOINT}/v1/logs`,
      `${ENDPOINT}/v1/metrics`,
    ]);
  });

  it("counts 429, 502, 503, and 504 as a throw, and stops at the time limit", async () => {
    for (const status of [429, 502, 503, 504]) {
      const r = recorder(() => new Response(null, { status }));
      const sink = otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch });
      await expect(sink.write([internal])).rejects.toThrow(
        new RangeError(`otlpSink: /v1/logs answered ${status}`),
      );
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const never = recorder(() => new Promise<Response>(() => {}));
    const auth = authWith(
      otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: never.fetch }),
      100,
    );
    expect((await auth.handle(sessionRead())).status).toBe(500);
    const started = Date.now();
    await auth.observe.flush();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(2000);
    expect(never.sent).toHaveLength(1);
    expect(auth.observe.stats().dropped).toEqual({
      buffer_full: 0,
      sink_timeout: 1,
      sink_threw: 0,
    });
  });

  it("scrubs the header values", async () => {
    const r = recorder();
    const key = "otlp-key-0123456789abcdef";
    const token = "tok-9876543210fedcba";
    const sink = otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      headers: { "x-api-key": key, authorization: `Bearer ${token}` },
      fetch: r.fetch,
    });
    const leaked: AuthEvent = { ...internal, route: `POST /${key}`, rejected: [token] };
    await sink.write([leaked]);
    const text = JSON.stringify(r.sent.map((s) => s.body));
    expect(text).not.toContain(key);
    expect(text).not.toContain(token);
    const [record] = logRecords(r.sent[0]);
    expect(record.attributes).toContainEqual({
      key: "route",
      value: { stringValue: "POST /***" },
    });
    expect(record.attributes).toContainEqual({
      key: "rejected",
      value: { arrayValue: { values: [{ stringValue: "***" }] } },
    });
    // The headers themselves go out as given.
    const headers = new Headers(r.sent[0]?.init.headers);
    expect(headers.get("x-api-key")).toBe(key);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    // The secrets option scrubs too.
    const other = recorder();
    await otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      secrets: ["s3cr3t-value-of-the-app"],
      fetch: other.fetch,
    }).write([{ ...internal, route: "s3cr3t-value-of-the-app" }]);
    expect(JSON.stringify(other.sent[0]?.body)).not.toContain("s3cr3t-value-of-the-app");
  });

  it("follows no redirect", async () => {
    const r = recorder((url) =>
      url.startsWith(ENDPOINT)
        ? new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } })
        : ok(),
    );
    const sink = otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch });
    await expect(sink.write([internal])).rejects.toThrow(
      new RangeError("otlpSink: /v1/logs answered 302"),
    );
    expect(r.sent).toHaveLength(1);
  });

  it("sends its posts inside the waitUntil of handle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const done: string[] = [];
    const r = recorder(async (url) => {
      // The collector answers after a timer, so a post that the flush does not wait for ends late.
      await new Promise((resolve) => setTimeout(resolve, 20));
      done.push(url);
      return ok();
    });
    const auth = authWith(otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: r.fetch }));
    const waited: Promise<unknown>[] = [];
    const res = await auth.handle(sessionRead(), { waitUntil: (p) => void waited.push(p) });
    expect(res.status).toBe(500);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(done).toEqual([`${ENDPOINT}/v1/logs`]);
    const [record] = logRecords(r.sent[0]);
    expect(record.eventName).toBe("error.internal");
    expect(auth.observe.stats().dropped).toEqual({
      buffer_full: 0,
      sink_timeout: 0,
      sink_threw: 0,
    });
  });

  it("posts only the chosen signals, and makes no post with nothing to send", async () => {
    const r = recorder();
    const sink = otlpSink({
      endpoint: ENDPOINT,
      serviceName: "auth",
      signals: ["traces"],
      fetch: r.fetch,
    });
    await sink.write([internal]);
    expect(r.sent).toEqual([]);
    await sink.write([request]);
    expect(r.sent.map((s) => s.url)).toEqual([`${ENDPOINT}/v1/traces`]);
    const all = recorder();
    await otlpSink({ endpoint: ENDPOINT, serviceName: "auth", fetch: all.fetch }).write([]);
    expect(all.sent).toEqual([]);
  });

  it("refuses a bad endpoint, service name, or signal list with a TypeError", () => {
    const make = (o: Partial<Parameters<typeof otlpSink>[0]>) => () =>
      otlpSink({ endpoint: ENDPOINT, serviceName: "auth", ...o });
    const url = new TypeError("otlpSink: endpoint must be an absolute http or https URL");
    expect(make({ endpoint: "collector.example.test" })).toThrow(url);
    expect(make({ endpoint: "ftp://collector.example.test" })).toThrow(url);
    const query = new TypeError("otlpSink: endpoint must have no query and no fragment");
    expect(make({ endpoint: `${ENDPOINT}/?key=1` })).toThrow(query);
    expect(make({ endpoint: `${ENDPOINT}/#x` })).toThrow(query);
    const name = new TypeError("otlpSink: serviceName must be a string that is not empty");
    expect(make({ serviceName: "" })).toThrow(name);
    expect(make({ serviceName: 7 as never })).toThrow(name);
    const signals = new TypeError(
      "otlpSink: signals must name one or more of logs, traces, and metrics",
    );
    expect(make({ signals: [] })).toThrow(signals);
    expect(make({ signals: ["logs", "profiles" as never] })).toThrow(signals);
    const timeout = new TypeError("otlpSink: timeoutMs must be an integer of 1 or more");
    expect(make({ timeoutMs: 0 })).toThrow(timeout);
    expect(make({ timeoutMs: 1.5 })).toThrow(timeout);
    expect(make({ timeoutMs: "2000" as never })).toThrow(timeout);
    expect(make({ endpoint: "http://127.0.0.1:4318", signals: ["metrics"] })).not.toThrow();
  });
});
