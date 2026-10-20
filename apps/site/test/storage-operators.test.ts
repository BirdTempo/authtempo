import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The operators of the storage port against the three places that list them
// (review m2 of plan 12f Task 2). An operator in `Op` and in no doc fails here.
const PORT = readFileSync(`${REPO}packages/core/src/storage/port.ts`, "utf8");
const PLACES: Readonly<Record<string, string>> = {
  "concepts/storage-port.md": readFileSync(`${DOCS}docs/concepts/storage-port.md`, "utf8"),
  "guides/adapter.mdx": readFileSync(`${DOCS}docs/guides/adapter.mdx`, "utf8"),
  "core README": readFileSync(`${REPO}packages/core/README.md`, "utf8"),
};

/** The members of the `Op` union in port.ts. */
function ops(): string[] {
  const union = /export type Op =([^;]+);/.exec(PORT)?.[1] ?? "";
  return [...union.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
}

describe("the storage operators in the docs", () => {
  it("reads eight operators from port.ts", () => {
    expect(ops()).toEqual(["eq", "ne", "in", "lt", "lte", "gt", "gte", "startsWith"]);
  });

  it("lists exactly the operators of port.ts in each place", () => {
    for (const [place, text] of Object.entries(PLACES)) {
      // The site pages write "The operators are `eq`, ..."; the README writes "Operators: `eq ne ...`".
      const list =
        /The operators are ([^\n]+?)\./.exec(text)?.[1] ??
        /Operators: `([^`]+)`/.exec(text)?.[1] ??
        "";
      const named = list
        .replaceAll("`", "")
        .split(/[\s,]+/)
        .filter((w) => w !== "" && w !== "and");
      expect({ place, named }).toEqual({ place, named: ops() });
    }
  });

  it("states the startsWith rule in each place", () => {
    for (const [place, text] of Object.entries(PLACES))
      for (const term of [
        /parameter/,
        /substr/,
        /with case|Case counts/,
        /lone surrogate/,
        /\bNUL\b/,
        /whole table/,
      ])
        expect({ place, term: term.source, stated: term.test(text) }).toEqual({
          place,
          term: term.source,
          stated: true,
        });
  });
});
