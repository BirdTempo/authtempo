import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO } from "../scripts/lib/paths.ts";

/** A task of turbo.json: the keys that this test reads. */
interface Task {
  dependsOn?: string[];
  outputs?: string[];
  inputs?: string[];
}

// Turbo reads turbo.json as JSONC. The file holds comments on whole lines only.
const text = readFileSync(`${REPO}turbo.json`, "utf8").replace(/^\s*\/\/.*$/gm, "");
const tasks = (JSON.parse(text) as { tasks: Record<string, Task> }).tasks;

describe("the inputs of the site build in turbo.json (plan 11b Task 5, ruling 21)", () => {
  // The root pages read the root package.json, SECURITY.md, and LICENSE
  // (src/data/repo.ts). Turbo hashes the files of the package only, so
  // without these inputs a cache hit serves a stale license or empty state.
  it("hashes the files of the package and the three root files that the pages read", () => {
    expect(tasks["@authtempo/site#build"]?.inputs).toEqual([
      "$TURBO_DEFAULT$",
      "$TURBO_ROOT$/package.json",
      "$TURBO_ROOT$/SECURITY.md",
      "$TURBO_ROOT$/LICENSE",
    ]);
  });

  it("keeps the dependencies and the outputs of the build task", () => {
    expect(tasks["@authtempo/site#build"]?.dependsOn).toEqual(tasks.build?.dependsOn);
    expect(tasks["@authtempo/site#build"]?.outputs).toEqual(tasks.build?.outputs);
  });
});
