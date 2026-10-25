import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scim, scimTokenWorld as world } from "../scim/helpers.js";

// A named measure, out of the default test gate (fix wave of plan 12i, ruling
// 48). It writes 10 000 SCIM users in the memory store through the route and
// reads the list with no filter ten times (plan 12d Task 12, open point 8).
// Its time limit is 120 s, and it failed the plan 12i evidence runs at a load
// up to 40 by that limit. The other SCIM limits stay in scim/limits.test.ts.
// Run it by name: `pnpm turbo run measure --filter=@authtempo/core --force`
// (vitest.measure.config.ts). It needs no test server.

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";

beforeEach(() => {
  // A refused request and a kept owner row each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

describe("the SCIM list on the memory store at 10 000 users (plan 12d Task 12, a named measure)", () => {
  it("measures a list with no filter", async () => {
    const w = await world();
    // 10 000 SCIM users through the route. Each create moves the clock by
    // 600 ms, so the token stays under its limit of 1200 calls in 600 s.
    for (let i = 0; i < 10_000; i++) {
      const res = await scim(w, w.token, "POST", "/Users", {
        schemas: [USER_URN],
        userName: `u${String(i).padStart(5, "0")}@acme.example`,
      });
      if (res.status !== 201) expect(res.status, `create ${i}`).toBe(201);
      w.clock.advance(600);
    }
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const res = await scim(w, w.token, "GET", "/Users?count=100");
      const body = (await res.json()) as {
        totalResults: number;
        itemsPerPage: number;
        Resources: { userName: string }[];
      };
      times.push(performance.now() - started);
      w.clock.advance(600);
      expect([res.status, body.totalResults, body.itemsPerPage, body.Resources.length]).toEqual([
        200, 10_000, 100, 100,
      ]);
    }
    // The number is evidence for the docs, not a gate (open point 8 of plan 12d).
    console.log(
      `scim-list-measure store=memory rows=10000 runs=10 median_ms=${median(times).toFixed(2)} max_ms=${Math.max(...times).toFixed(2)}`,
    );
  }, 120_000);
});
