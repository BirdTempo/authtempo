import { afterEach, expect, it, vi } from "vitest";
import { analyticsEngineSink } from "../../src/analytics-engine.js";
import { otlpSink } from "../../src/otlp.js";
import { workersLogsSink } from "../../src/workers-logs.js";
import { built } from "../events.js";

// The three sinks in workerd (plan 12h Tasks 10 and 11): the console of the
// pool, a fake dataset, and a fake fetch. The pool refuses a real outbound fetch.

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes each event as one plain object to the console of workerd", async () => {
  expect(typeof navigator !== "undefined" && navigator.userAgent).toBe("Cloudflare-Workers");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const event = built("error.internal", "error", {
    method: "GET",
    route: "unmatched",
    errorName: "TypeError",
  });
  await workersLogsSink().write([event]);
  expect(error.mock.calls).toEqual([[event]]);
});

it("writes one data point for a chosen event to a dataset in workerd", async () => {
  const points: unknown[] = [];
  const dataset = { writeDataPoint: (p: unknown) => void points.push(p) };
  await analyticsEngineSink(dataset).write([
    built("limit.hit", "warn", { family: "magic-link:email" }),
  ]);
  expect(points).toEqual([
    {
      indexes: ["limit.hit"],
      blobs: [
        "limit.hit",
        null,
        null,
        null,
        null,
        null,
        "magic-link:email",
        "4bf92f3577b34da6a3ce929d0e0e4736",
      ],
      doubles: [1, 0, 0],
    },
  ]);
});

it("posts the three OTLP bodies through the fetch of the app in workerd", async () => {
  const sent: { url: string; redirect: RequestInit["redirect"]; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      redirect: init?.redirect,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  const request = built("request", "info", {
    route: "POST /password/sign-in",
    method: "POST",
    status: 200,
    outcome: "ok",
    durationMs: 12,
  });
  await otlpSink({ endpoint: "https://collector.example.test", serviceName: "auth", fetch }).write([
    request,
  ]);
  expect(sent.map((s) => [s.url, s.redirect])).toEqual([
    ["https://collector.example.test/v1/logs", "manual"],
    ["https://collector.example.test/v1/traces", "manual"],
    ["https://collector.example.test/v1/metrics", "manual"],
  ]);
  expect(sent[1]?.body).toMatchObject({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: "POST /password/sign-in",
                kind: 2,
                startTimeUnixNano: "1792576799988000000",
                endTimeUnixNano: "1792576800000000000",
              },
            ],
          },
        ],
      },
    ],
  });
});
