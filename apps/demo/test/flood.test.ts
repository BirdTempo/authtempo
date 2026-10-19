import { describe, expect, it } from "vitest";
import { DEMO_LIMITS } from "../src/facts.js";
import { IsolateCount } from "../src/flood.js";
import { call, type Jar, newSandbox } from "./helpers.js";

// The first limit of the Worker (final review m7 of plan 11b): a count per IP
// in one isolate, before any Durable Object call.
describe("the count of one isolate", () => {
  it("takes the limit per key per minute, then refuses until the minute ends", () => {
    const count = new IsolateCount(3, 100);
    const t = 1_000_000;
    expect([1, 2, 3, 4].map(() => count.take("192.0.2.1", t))).toEqual([true, true, true, false]);
    // Another key counts alone.
    expect(count.take("192.0.2.2", t)).toBe(true);
    // An IPv6 address counts by the key of core ipKey, so a rotated address in one /64 shares it.
    expect([1, 2, 3, 4].map((i) => count.take(`2001:db8:1:2::${i}`, t))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(count.take("192.0.2.1", t + 59_999)).toBe(false);
    expect(count.take("192.0.2.1", t + 60_000)).toBe(true);
  });

  it("keeps at most maxKeys keys", () => {
    const count = new IsolateCount(1, 2);
    expect(count.take("192.0.2.1", 0)).toBe(true);
    expect(count.take("192.0.2.2", 0)).toBe(true);
    // A third key in a full table starts it again, so memory stays bounded.
    expect(count.take("192.0.2.3", 0)).toBe(true);
    expect(count.take("192.0.2.1", 0)).toBe(true);
  });

  it("refuses a request over the limit before its sandbox answers", async () => {
    const jar = await newSandbox();
    // A live sandbox answers /whoami with 401 and no session. The address is only this test's.
    const flood: Jar = { cookies: new Map(jar.cookies), ip: "203.0.113.200" };
    const statuses = new Map<number, number>();
    for (let i = 0; i < DEMO_LIMITS.requestsPerIpPerMinute; i++) {
      const res = await call(flood, "GET", "/whoami");
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
    expect(Object.fromEntries(statuses)).toEqual({ 401: 600 });
    const over = await call(flood, "GET", "/whoami");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "demo_limit", limit: "requestsPerIpPerMinute" });
    // Another address still reaches the same sandbox.
    expect((await call(jar, "GET", "/whoami")).status).toBe(401);
  });
});
