import { type AuthEvent, EVENTS, type EventSpec } from "@authtempo/core/observe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workersLogsSink } from "../src/workers-logs.js";
import { built } from "./events.js";
import { largestEvent } from "./largest.js";

const request = built("request", "info", { route: "POST /password/sign-in", status: 200 });
const dropped = built("observe.dropped", "warn", {
  buffer_full: 3,
  sink_timeout: 0,
  sink_threw: 0,
});
const internal = built("error.internal", "error", {
  method: "POST",
  route: "POST /password/sign-in",
  errorName: "TypeError",
});

function spies() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workersLogsSink", () => {
  it("writes one console call with one plain object for each event", async () => {
    const c = spies();
    await workersLogsSink().write([request, dropped, internal]);
    const calls = [c.log.mock.calls, c.warn.mock.calls, c.error.mock.calls];
    expect(calls.map((m) => m.length)).toEqual([1, 1, 1]);
    for (const [m, event] of [
      [c.log.mock.calls, request],
      [c.warn.mock.calls, dropped],
      [c.error.mock.calls, internal],
    ] as const) {
      const args = m[0] ?? [];
      expect(args).toHaveLength(1);
      expect(Object.getPrototypeOf(args[0])).toBe(Object.prototype);
      expect(args[0]).toEqual(event);
    }
  });

  it("drops events under minLevel", async () => {
    const c = spies();
    await workersLogsSink({ minLevel: "warn" }).write([request, dropped, internal]);
    expect([c.log.mock.calls.length, c.warn.mock.calls.length, c.error.mock.calls.length]).toEqual([
      0, 1, 1,
    ]);
  });

  it("refuses an unknown minLevel with a TypeError", () => {
    expect(() => workersLogsSink({ minLevel: "debug" as never })).toThrow(
      new TypeError("workersLogsSink: minLevel must be info, warn, or error"),
    );
    expect(() => workersLogsSink({ minLevel: "toString" as never })).toThrow(TypeError);
  });

  it("scrubs each string field with the given secrets", async () => {
    const c = spies();
    const secret = "s3cr3t-value-of-the-app";
    const leaked: AuthEvent = { ...internal, route: secret, rejected: [secret, "status"] };
    await workersLogsSink({ secrets: [secret] }).write([leaked]);
    expect(c.error.mock.calls[0]?.[0]).toEqual({
      ...internal,
      route: "***",
      rejected: ["***", "status"],
    });
  });

  it("keeps the kind-checked fields out of the scrub", async () => {
    const c = spies();
    // A short secret that is a part of the event name, the level, and the ids.
    await workersLogsSink({ secrets: ["drop", "warn", "4bf9", "00f0", "2026"] }).write([dropped]);
    expect(c.warn.mock.calls[0]?.[0]).toEqual(dropped);
  });

  it("stays far under the 256 KB limit of a log", async () => {
    const c = spies();
    const event = largestEvent();
    await workersLogsSink().write([event]);
    const written = c.error.mock.calls[0]?.[0] as Record<string, unknown>;
    // The line holds every field of every row: a lost field makes a small line, not a small event.
    const names = Object.values(EVENTS as Record<string, EventSpec>).flatMap((s) =>
      Object.keys(s.fields),
    );
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) expect(Object.keys(written)).toContain(name);
    const line = JSON.stringify(written);
    expect(new TextEncoder().encode(line).byteLength).toBeLessThan(16 * 1024);
  });
});
