import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STACK_INFO, STACKS, type Stack } from "../src/templates.js";
import { assertFreshBuild, PKG, REPO, runBin } from "./support/bin.js";

// Each scaffold of `authtempo init` is compiled and runs its own test in a
// folder inside the workspace (plan 11c). Its node_modules is a link to the
// node_modules of the example it copies: the scaffold is that example, so
// the link resolves every import. The Postgres stacks need docker compose.

/** The lines that each stack's own test prints when it passes. */
const PASSES: Readonly<Record<Stack, readonly string[]>> = {
  // The tests line with its label: a bare count also matches the files line (plan 11d Task 14 review, L3).
  "workers-d1": ["Tests  3 passed (3)"],
  "workers-postgres": ["2 passed", "--dry-run: exiting now."],
  node: ["node-e2e: PASS", "bun-e2e: PASS"],
  bun: ["node-e2e: PASS", "bun-e2e: PASS"],
  // The MCP example: its test file has five tests, and the guarded fetch's file has 44.
  "mcp-server": ["Test Files  2 passed (2)", "Tests  49 passed (49)"],
};

beforeAll(() => {
  assertFreshBuild();
});

/** The scaffolds that passed: removed after the file. A failed scaffold stays, for diagnosis. */
const passed: string[] = [];
afterAll(() => {
  for (const dir of passed) rmSync(dir, { recursive: true, force: true });
});

/** A package script of the scaffold, through sh, with the scaffold's node_modules/.bin first on PATH, as pnpm runs it. */
function script(dir: string, name: string) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return spawnSync("sh", ["-c", pkg.scripts[name] ?? `echo no script ${name}; exit 1`], {
    cwd: dir,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, PATH: `${join(dir, "node_modules", ".bin")}:${process.env.PATH ?? ""}` },
  });
}

for (const stack of STACKS)
  describe(`the ${stack} scaffold (plan 11c)`, { timeout: 900_000 }, () => {
    it("compiles, and passes its own test", () => {
      const dir = join(PKG, ".scaffold", `scaffold-${stack}-${crypto.randomUUID().slice(0, 8)}`);
      const init = runBin(["init", dir, "--stack", stack]);
      expect(init.status, init.stderr).toBe(0);
      symlinkSync(
        join(REPO, "examples", STACK_INFO[stack].example, "node_modules"),
        join(dir, "node_modules"),
        "dir",
      );
      const typecheck = script(dir, "typecheck");
      expect(typecheck.status, `${typecheck.stdout}${typecheck.stderr}`).toBe(0);
      const test = script(dir, "test");
      // Without its colour codes, so a pass line can name its label (vitest colours "Tests").
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI escape is the match.
      const out = `${test.stdout}${test.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
      expect(test.status, out).toBe(0);
      for (const line of PASSES[stack]) expect(out).toContain(line);
      passed.push(dir);
    });
  });
