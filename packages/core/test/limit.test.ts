import { describe, expect, it } from "vitest";
import { LIMIT_FAMILIES, limit } from "../src/limiter/limit.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { LimiterPort, LimitWindow } from "../src/limiter/port.js";
import type { AuthEvent } from "../src/observe/port.js";
import { makeAuth, post } from "./helpers.js";
import { oauthHandle } from "./oauth-helpers.js";
import { observed } from "./observe-helpers.js";

/** A limiter port that keeps each call, over a real memory limiter. */
function recording(inner: LimiterPort) {
  const calls: { key: string; window: LimitWindow }[] = [];
  const port: LimiterPort = {
    allow(key, window) {
      calls.push({ key, window });
      return inner.allow(key, window);
    },
  };
  return { port, calls };
}

const ADDRESS = "a@example.com";

describe("the limit helper (plan 12h Task 7)", () => {
  it("builds the same stored key as before", async () => {
    const base = makeAuth();
    const { port, calls } = recording(createMemoryLimiter(base.clock));
    const { config } = makeAuth({ limiter: port, clock: base.clock });
    const w = { seconds: 60, max: 1000 };
    for (const family of LIMIT_FAMILIES) await limit(config, family, "s", w);
    expect(calls).toHaveLength(LIMIT_FAMILIES.length);
    for (const [i, family] of LIMIT_FAMILIES.entries())
      expect(calls[i]).toEqual({ key: `${family}:s`, window: w });

    // Three keys of three families, typed as the stored form of every release before.
    calls.length = 0;
    const two = { seconds: 60, max: 2 };
    const table = [
      ["magic-link:email", ADDRESS, "magic-link:email:a@example.com"],
      ["oauth-token:ip", "203.0.113.9", "oauth-token:ip:203.0.113.9"],
      ["token-use:tk", "01JTOKENROW", "token-use:tk:01JTOKENROW"],
    ] as const;
    for (const [family, subject, stored] of table) {
      expect(await limit(config, family, subject, two)).toBe(true);
      expect(await limit(config, family, subject, two)).toBe(true);
      expect(await limit(config, family, subject, two)).toBe(false);
      expect(calls.splice(0).map((c) => c.key)).toEqual([stored, stored, stored]);
    }
  });

  it("emits limit.hit with the family only", async () => {
    const o = observed();
    const request = () => o.auth.handle(post("/auth/magic-link/request", { email: ADDRESS }));
    // magic-link:email allows 5 calls in 15 minutes; magic-link:ip allows 20.
    for (let i = 0; i < 5; i++) expect((await request()).status).toBe(200);
    const refused = await request();
    expect(refused.status).toBe(429);
    const hits = (await o.events()).filter((e) => e.name === "limit.hit");
    expect(hits).toHaveLength(1);
    const [hit] = hits as [AuthEvent];
    expect(hit.family).toBe("magic-link:email");
    expect(hit.level).toBe("warn");
    // The event of the request: its trace, and no rejected field (no unscoped mark).
    expect(hit.traceId).toBe(refused.headers.get("x-authtempo-trace"));
    expect(hit.rejected).toBeUndefined();
    expect(Object.keys(hit).sort()).toEqual([
      "at",
      "family",
      "level",
      "name",
      "route",
      "spanId",
      "traceId",
    ]);
    const text = JSON.stringify(hit);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain(`:${ADDRESS}`);
    expect(text).not.toContain("example.com");
  });

  it("keeps the counts of a window across the change", async () => {
    const { config } = makeAuth();
    const window = { seconds: 15 * 60, max: 5 };
    // A window from before the upgrade: 4 calls on the stored key of plan 1.
    for (let i = 0; i < 4; i++)
      expect(await config.limiter.allow("magic-link:email:a@example.com", window)).toBe(true);
    expect(await limit(config, "magic-link:email", ADDRESS, window)).toBe(true);
    expect(await limit(config, "magic-link:email", ADDRESS, window)).toBe(false);
  });

  it("keeps the trace of the request on a limit hit of the token origin check", async () => {
    const batches: AuthEvent[][] = [];
    const h = oauthHandle({ observe: { sink: { write: (b) => void batches.push([...b]) } } });
    const foreign = () =>
      h.auth.handle(
        new Request("https://api.example.com/auth/oauth/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://client.example.com",
          },
          body: "grant_type=authorization_code",
        }),
      );
    // oauth-token-origin:ip allows 60 calls in 15 minutes.
    for (let i = 0; i < 60; i++) expect((await foreign()).status).not.toBe(429);
    const refused = await foreign();
    expect(refused.status).toBe(429);
    await h.auth.observe.flush();
    const hits = batches.flat().filter((e) => e.name === "limit.hit");
    expect(hits.map((e) => e.family)).toEqual(["oauth-token-origin:ip"]);
    expect(hits[0]?.traceId).toBe(refused.headers.get("x-authtempo-trace"));
    expect(hits[0]?.rejected).toBeUndefined();
  });
});
