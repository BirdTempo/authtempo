import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_LIMITS } from "../src/facts.js";
import { PAGE_POLICY } from "../src/html.js";
import { utcTime } from "../src/pages/layout.js";
import { call, type Jar } from "./helpers.js";

// A refused page view gets a page, not raw JSON (final review Low 3 of plan
// 11b). A browser navigation sends Accept with text/html. Any other request
// keeps the JSON body that limits.test.ts holds.
const VIEW = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

/** The text of each paragraph of the main element. */
function paragraphs(doc: string): string[] {
  const main = doc.split("<main>")[1]?.split("</main>")[0] ?? "";
  return [...main.matchAll(/<(?:h1|p)>([^<]*)<\/(?:h1|p)>/g)].map((m) => m[1] ?? "");
}

/** The time of the oldest gate row of `ip`, in ms since the epoch. */
function oldestRow(ip: string): Promise<number> {
  return runInDurableObject(env.GATE.get(env.GATE.idFromName("gate")), (_i, state) =>
    Number(state.storage.sql.exec("SELECT min(at) AS m FROM admit WHERE ip = ?", ip).one().m),
  );
}

describe("a refused page view", () => {
  it("names the limit sandboxesPerIp and the time to try again", async () => {
    const ip = "198.51.100.41";
    for (let i = 0; i < DEMO_LIMITS.sandboxesPerIp; i++)
      expect((await call({ cookies: new Map(), ip }, "GET", "/")).status).toBe(303);
    const res = await call({ cookies: new Map(), ip }, "GET", "/password", undefined, VIEW);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(PAGE_POLICY);
    const wait = Number(res.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(3_500);
    expect(wait).toBeLessThanOrEqual(3_600);
    expect(paragraphs(await res.text())).toEqual([
      "The demo limit is reached",
      "This address made 5 sandboxes in the last hour. That is the limit sandboxesPerIp.",
      "A shared address, as of an office or a phone network, counts as one visitor.",
      `Try again after ${utcTime((await oldestRow(ip)) + 3_600_000)}.`,
    ]);
    // A call of a page script asks for JSON, and it keeps the JSON body.
    const api = await call({ cookies: new Map(), ip }, "GET", "/");
    expect(await api.json()).toEqual({ error: "demo_limit", limit: "sandboxesPerIp" });
    expect(api.headers.get("retry-after")).toBe(res.headers.get("retry-after"));
  });

  it("names the limit requestsPerIpPerMinute", async () => {
    const flood: Jar = { cookies: new Map(), ip: "198.51.100.42" };
    // A post with no sandbox makes no Durable Object call, so it is the cheapest request to count.
    for (let i = 0; i < DEMO_LIMITS.requestsPerIpPerMinute; i++)
      expect((await call(flood, "POST", "/reset")).status).toBe(303);
    const res = await call(flood, "GET", "/", undefined, VIEW);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    const text = paragraphs(await res.text());
    expect(text.slice(0, 2)).toEqual([
      "The demo limit is reached",
      "This address sent more than 600 requests in one minute. That is the limit requestsPerIpPerMinute.",
    ]);
    expect(text[2]).toMatch(/^Try again after \d\d:\d\d UTC\.$/);
  });

  it("explains a cross-site post to /reset", async () => {
    const res = await call({ cookies: new Map() }, "POST", "/reset", new URLSearchParams(), {
      ...VIEW,
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(paragraphs(await res.text())).toEqual([
      "The demo did not start again",
      "Another site sent this request, so the demo refused it.",
      "To start again, use the Start again button of a demo page.",
    ]);
  });
});
