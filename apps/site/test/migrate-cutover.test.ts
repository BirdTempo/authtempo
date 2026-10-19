import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = new URL("../src/content/docs/docs/migrate/cutover.md", import.meta.url);

/**
 * The 1.7.7 caution of spec 23 item 12. The cutover page starts its body with it,
 * right after the list of "Before you start" and before "Steps". This test holds the
 * page copy, as migrate-better-auth.test.ts holds the caution of the Better Auth guide.
 */
const CAUTION = [
  ":::caution",
  "Warning: on Better Auth below 1.7.7, upgrade to 1.7.7 or later before the move. Version 1.7.7 fixed a magic link takeover, and the old system stays the rollback target.",
  ":::",
] as const;

/** The lines from the line `from` to the next heading, with the blank lines removed. */
function partAfter(from: string): string[] {
  const lines = readFileSync(PAGE, "utf8").split("\n");
  const start = lines.indexOf(from);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("#"));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== "");
}

describe("the cutover page", () => {
  it("starts its body with the 1.7.7 caution, after the list of Before you start", () => {
    const before = partAfter("## Before you start");
    const list = before.slice(0, -CAUTION.length);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((l) => l.startsWith("- "))).toBe(true);
    expect(before.slice(-CAUTION.length)).toEqual([...CAUTION]);
  });
});
