import { afterEach, expect, it, vi } from "vitest";
import { analyticsEngineSink } from "../../src/analytics-engine.js";
import { workersLogsSink } from "../../src/workers-logs.js";
import { built } from "../events.js";

// The two sinks in workerd (plan 12h Task 10): the console of the pool and a fake dataset.

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
