import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFLICT_REASONS } from "../src/types.js";

/**
 * The README names the conflicts by hand. This test ties that list to
 * `CONFLICT_REASONS`, so the two cannot drift in silence.
 */
export function readmeConflicts(text: string): string[] {
  const start = text.indexOf("The conflicts are ");
  const end = text.indexOf("(`CONFLICT_REASONS`", start);
  if (start === -1 || end === -1) throw new Error("the README has no conflict list");
  return [...text.slice(start, end).matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
}

describe("the README conflict list", () => {
  it("names exactly CONFLICT_REASONS", () => {
    const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readmeConflicts(text).sort()).toEqual([...CONFLICT_REASONS].sort());
  });
});
