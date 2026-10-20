import { createAuth, createMemoryAdapter } from "@authtempo/core";
import { DPOP_WINDOW_SECONDS } from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";
import { resolveDpop } from "../src/dpop.js";

/**
 * The DPoP window rule has one copy, in core (review L5 of plan 12e). The
 * verify package and core's config take and refuse the same values.
 */

const clock = { now: () => new Date("2026-10-20T00:00:00Z") };

/** "ok" when core's config takes `windowSeconds`, else the error message. */
function coreTakes(windowSeconds?: number): string {
  try {
    createAuth({
      baseURL: "https://api.example.com",
      trustedOrigins: ["https://app.example.com"],
      secret: "0123456789abcdef0123456789abcdef",
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      oauth: {
        resources: ["https://api.example.com/mcp"],
        registration: { cimd: false },
        ...(windowSeconds !== undefined ? { dpop: { windowSeconds } } : {}),
      },
    });
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
}

/** The window of the verify package for `windowSeconds`, or the error message. */
function verifyWindow(windowSeconds?: number): number | string {
  try {
    return resolveDpop(windowSeconds !== undefined ? { windowSeconds } : {}, clock).windowSeconds;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("the DPoP window rule (review L5 of plan 12e)", () => {
  it("names a default of 60 and a range of 10 to 300 in one copy", () => {
    expect(DPOP_WINDOW_SECONDS).toEqual({ default: 60, min: 10, max: 300 });
  });

  it("gives core and verify the same default, bounds, and refusals", () => {
    for (const [value, window] of [
      [undefined, 60],
      [10, 10],
      [300, 300],
    ] as const) {
      expect(verifyWindow(value)).toBe(window);
      expect(coreTakes(value)).toBe("ok");
    }
    for (const value of [9, 301, 60.5]) {
      expect(verifyWindow(value)).toBe(
        "authtempo verify: dpop.windowSeconds must be an integer from 10 to 300",
      );
      expect(coreTakes(value)).toContain(
        "oauth.dpop.windowSeconds must be an integer from 10 to 300",
      );
    }
  });
});
