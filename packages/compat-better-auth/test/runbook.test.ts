import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import worker from "./d1/move-keys/worker.ts?raw";

/** The text of the first ts fence after `heading` in the README. */
function fenceAfter(heading: string): string | null {
  const start = readme.indexOf(`\n${heading}\n`);
  if (start < 0) return null;
  const open = readme.indexOf("```ts\n", start);
  const close = readme.indexOf("\n```", open + 6);
  return open < 0 || close < 0 ? null : readme.slice(open + 6, close + 1);
}

describe("the key cutover runbook (final review of plan 12k, m5)", () => {
  it("holds the D1 move Worker that the D1 test runs, with the package import", () => {
    expect(fenceAfter("#### The move on D1")).toBe(
      worker.replace('"../../../src/index.js"', '"@authtempo/compat-better-auth"'),
    );
  });
});
