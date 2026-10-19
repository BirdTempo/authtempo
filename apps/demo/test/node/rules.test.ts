import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A rule of the pool tests (Task 12 re-review of plan 11b, Low 2). The cookie
// rule reads each answer that fetchSelf() of helpers.ts keeps. A SELF.fetch
// in another file would send a request that the rule never reads.
const TESTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the pool test files", () => {
  it("send each request through fetchSelf of helpers.ts", () => {
    const files = readdirSync(TESTS).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("helpers.ts");
    const raw = files.filter(
      (f) => f !== "helpers.ts" && readFileSync(join(TESTS, f), "utf8").includes("SELF.fetch"),
    );
    expect(raw).toEqual([]);
  });
});
