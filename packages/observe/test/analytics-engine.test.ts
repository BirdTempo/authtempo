import { EVENTS, type EventName } from "@authtempo/core/observe";
import { describe, expect, it } from "vitest";
import { AE_BLOBS, AE_MAX_POINTS, analyticsEngineSink } from "../src/analytics-engine.js";
import { built } from "./events.js";

type Point = { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] };

function dataset() {
  const points: Point[] = [];
  return { points, writeDataPoint: (p: Point) => void points.push(p) };
}

const signIn = built("sign_in", "info", {
  route: "POST /password/sign-in",
  outcome: "success",
  method: "password",
  durationMs: 42,
  status: 200,
});

describe("analyticsEngineSink", () => {
  it("writes one data point for each chosen event", async () => {
    const d = dataset();
    const chosen = ["request", "sign_in", "second_factor.challenge", "limit.hit", "sweep"].map(
      (name) => built(name, "info"),
    );
    const other = built("observe.dropped", "warn", {
      buffer_full: 1,
      sink_timeout: 0,
      sink_threw: 0,
    });
    await analyticsEngineSink(d).write([...chosen, other]);
    expect(d.points.map((p) => p.indexes)).toEqual([
      ["request"],
      ["sign_in"],
      ["second_factor.challenge"],
      ["limit.hit"],
      ["sweep"],
    ]);
    const only = dataset();
    await analyticsEngineSink(only, { events: ["observe.dropped"] }).write([...chosen, other]);
    expect(only.points.map((p) => p.indexes)).toEqual([["observe.dropped"]]);
  });

  it("uses the event name as the index and the fixed blob order", async () => {
    const d = dataset();
    await analyticsEngineSink(d).write([signIn]);
    expect(AE_BLOBS).toEqual([
      "name",
      "route",
      "outcome",
      "code",
      "method",
      "provider",
      "family",
      "traceId",
    ]);
    expect(d.points).toEqual([
      {
        indexes: ["sign_in"],
        blobs: [
          "sign_in",
          "POST /password/sign-in",
          "success",
          null,
          "password",
          null,
          null,
          "4bf92f3577b34da6a3ce929d0e0e4736",
        ],
        doubles: [1, 42, 200],
      },
    ]);
    const bare = dataset();
    await analyticsEngineSink(bare).write([built("sweep", "info")]);
    expect(bare.points[0]?.doubles).toEqual([1, 0, 0]);
  });

  it("keeps every index under 96 bytes", async () => {
    const names = Object.keys(EVENTS) as EventName[];
    expect(names.length).toBeGreaterThan(60);
    const d = dataset();
    await analyticsEngineSink(d, { events: names }).write(
      names.map((name) => built(name, EVENTS[name].level)),
    );
    expect(d.points.map((p) => p.indexes)).toEqual(names.map((name) => [name]));
    for (const name of names) expect(new TextEncoder().encode(name).byteLength).toBeLessThan(96);
  });

  it("writes at most 200 points for each flush and counts the rest", async () => {
    const d = dataset();
    const batch = Array.from({ length: 250 }, () => signIn);
    expect(AE_MAX_POINTS).toBe(200);
    expect(() => analyticsEngineSink(d).write(batch)).toThrow(
      new RangeError(
        "analyticsEngineSink: 50 events dropped over the cap of 200 data points for each flush",
      ),
    );
    expect(d.points).toHaveLength(200);
    const under = dataset();
    await analyticsEngineSink(under).write(batch.slice(0, 200));
    expect(under.points).toHaveLength(200);
  });
});
