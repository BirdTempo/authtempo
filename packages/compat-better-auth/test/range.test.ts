import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BETTER_AUTH_RANGE, inRange } from "../src/version.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../package.json")) as { authtempo?: { betterAuth?: unknown } };
const line = (range: string) => `Supported Better Auth versions: \`${range}\`.`;

describe("the supported Better Auth range (spec 33 item 1.6)", () => {
  it("holds the range in one value", () => {
    expect(manifest.authtempo?.betterAuth).toBe(BETTER_AUTH_RANGE);
    expect(read("../README.md").split("\n")).toContain(line(BETTER_AUTH_RANGE));
    const page = read("../../../apps/site/src/content/docs/docs/reference/compat-better-auth.md");
    expect(page.split("\n")).toContain(line(BETTER_AUTH_RANGE));
  });

  it("holds the fixed version inside the range", () => {
    // The CLI warns below BETTER_AUTH_FIXED. The compat package does not depend
    // on the CLI, so the test reads the source as text.
    const source = read("../../cli/src/better-auth-version.ts");
    const m = /export const BETTER_AUTH_FIXED[^=]*= \[(\d+), (\d+), (\d+)\];/.exec(source);
    expect(m).not.toBeNull();
    const fixed = [m?.[1], m?.[2], m?.[3]].map(Number);
    expect(fixed).toEqual([1, 7, 7]);
    expect(inRange(fixed.join("."), BETTER_AUTH_RANGE)).toBe(true);
  });

  it("reads the range grammar", () => {
    expect(inRange("1.7.0", BETTER_AUTH_RANGE)).toBe(true);
    expect(inRange("1.7.10", BETTER_AUTH_RANGE)).toBe(true);
    expect(inRange("1.8.0", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.6.22", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.7.7-beta.1", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.7", BETTER_AUTH_RANGE)).toBe(false);
    expect(() => inRange("1.7.7", "^1.7.0")).toThrow();
    expect(() => inRange("1.7.7", ">=1.7.0")).toThrow();
  });
});
