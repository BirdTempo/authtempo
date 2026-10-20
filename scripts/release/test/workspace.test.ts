import { describe, expect, it } from "vitest";
import { readGlobs } from "../src/lib/workspace.ts";

describe("readGlobs", () => {
  it("reads each glob under packages", () => {
    expect(readGlobs("packages:\n  - packages/*\n  - 'apps/*'\n  - examples/node\n")).toEqual([
      "packages/*",
      "apps/*",
      "examples/node",
    ]);
  });

  it("stops at the next top-level key", () => {
    expect(readGlobs("packages:\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n")).toEqual([
      "packages/*",
    ]);
  });

  it("throws on another glob form", () => {
    expect(() => readGlobs("packages:\n  - packages/**\n")).toThrow(
      'pnpm-workspace.yaml: the glob packages/** is not "<folder>/*" or "<folder>"',
    );
  });
});
