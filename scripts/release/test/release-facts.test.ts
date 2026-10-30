import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// src/lib/release-facts.ts holds each fact that more than one file reads.
// check-deprecations kept its own FIRST_RELEASE (ruling 67 of plan 12j, Low
// 5), so a change of the fact could miss it. This test holds each name of
// release-facts.ts to one declaration in src.
const SRC = new URL("../src/", import.meta.url);
const FACTS = readFileSync(new URL("lib/release-facts.ts", SRC), "utf8");
const NAMES = [...FACTS.matchAll(/^export const ([A-Z][A-Z0-9_]+) =/gm)].map((m) => m[1] ?? "");

/** Each .ts file of src, by its path from src, but release-facts.ts. */
const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && f !== "lib/release-facts.ts")
  .sort();

/** The faults of `text`: a declaration of a name of release-facts.ts. */
const faults = (file: string, text: string) =>
  NAMES.filter((name) => new RegExp(`\\b(?:const|let|var) ${name}\\b`).test(text)).map(
    (name) => `${file} declares ${name}; import it from src/lib/release-facts.ts`,
  );

describe("src/lib/release-facts.ts", () => {
  it("is the one declaration of each of its facts in src", () => {
    expect(NAMES).toContain("FIRST_RELEASE");
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap((f) => faults(f, readFileSync(new URL(f, SRC), "utf8")))).toEqual([]);
    // The fault form, so the test can fail.
    expect(faults("x.ts", 'const FIRST_RELEASE = "0.1.0";\n')).toEqual([
      "x.ts declares FIRST_RELEASE; import it from src/lib/release-facts.ts",
    ]);
  });
});
