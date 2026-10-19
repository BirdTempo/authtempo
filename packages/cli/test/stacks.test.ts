import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STACK_INFO, STACKS } from "../src/templates.js";
import { assertFreshBuild, PKG } from "./support/bin.js";

// The entry @authtempo/cli/stacks (plan 11b Task 5, ruling 20 of its lane). The
// site bundles it into its build, so it must import nothing and read no file.
const source = readFileSync(`${PKG}src/stacks.ts`, "utf8");

describe("the stacks entry (plan 11b)", () => {
  it("imports nothing, so it reads no file at load", () => {
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*export\s[^;]*\bfrom\s/m);
  });

  it("exports the tables that templates.ts and ./program re-export", async () => {
    assertFreshBuild();
    const stacks = await import("@authtempo/cli/stacks");
    const program = await import("@authtempo/cli/program");
    expect(stacks.STACKS).toEqual(STACKS);
    expect(stacks.STACK_INFO).toEqual(STACK_INFO);
    expect(program.STACKS).toBe(stacks.STACKS);
    expect(program.STACK_INFO).toBe(stacks.STACK_INFO);
  });
});
