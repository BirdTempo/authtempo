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
});
// The request event carries the duration and the status (plan 12h Task 4).
const request = built("request", "info", {
  route: "POST /password/sign-in",
  method: "POST",
  status: 200,
  outcome: "ok",
  durationMs: 42,
});

describe("analyticsEngineSink", () => {
  it("writes one data point for each chosen event", async () => {
    const d = dataset();
    // Each event at the level of its row: limit.hit is a warn (plan 12h Task 7).
    const names = ["request", "sign_in", "second_factor.challenge", "limit.hit", "sweep"] as const;
    const chosen = names.map((name) => built(name, EVENTS[name].level));
    const other = built("error.internal", "error", { method: "POST", errorName: "TypeError" });
    await analyticsEngineSink(d).write([...chosen, other]);
    expect(d.points.map((p) => p.indexes)).toEqual([
      ["request"],
      ["sign_in"],
      ["second_factor.challenge"],
      ["limit.hit"],
      ["sweep"],
    ]);
    const only = dataset();
    await analyticsEngineSink(only, { events: ["error.internal"] }).write([...chosen, other]);
    expect(only.points.map((p) => p.indexes)).toEqual([["error.internal"]]);
  });

  it("writes observe.dropped by default, so a drop shows in the dataset", async () => {
    const d = dataset();
    const dropped = built("observe.dropped", "warn", {
      buffer_full: 3,
      sink_timeout: 0,
      sink_threw: 0,
    });
    await analyticsEngineSink(d).write([dropped]);
    expect(d.points).toEqual([
      {
        indexes: ["observe.dropped"],
        blobs: [
          "observe.dropped",
          null,
          null,
          null,
          null,
          null,
          null,
          "4bf92f3577b34da6a3ce929d0e0e4736",
        ],
        doubles: [1, 0, 0],
      },
    ]);
  });

  it("scrubs each blob with the given secrets", async () => {
    const d = dataset();
    const secret = "s3cr3t-value-of-the-app";
    const leaked = { ...signIn, route: `POST /${secret}/sign-in`, code: secret };
    await analyticsEngineSink(d, { secrets: [secret] }).write([leaked]);
    expect(d.points[0]?.blobs).toEqual([
      "sign_in",
      "POST /***/sign-in",
      "success",
      "***",
      "password",
      null,
      null,
      "4bf92f3577b34da6a3ce929d0e0e4736",
    ]);
    const plain = dataset();
    await analyticsEngineSink(plain).write([leaked]);
    expect(plain.points[0]?.blobs?.[3]).toBe(secret);
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
        doubles: [1, 0, 0],
      },
    ]);
    const timed = dataset();
    await analyticsEngineSink(timed).write([request]);
    expect(timed.points[0]?.doubles).toEqual([1, 42, 200]);
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
