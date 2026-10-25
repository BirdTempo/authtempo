import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STACK_INFO, STACKS } from "../src/stacks.js";
import { PKG, REPO } from "./support/bin.js";

// test/init-scaffold.test.ts compiles each scaffold and runs its test. The
// scaffold imports the workspace packages of its example through the
// example's node_modules, so each of them needs its dist before the CLI test
// starts. Assume that no task of the CLI test graph builds a package. Then
// the run fails with "Cannot resolve" on a clean tree. It passes on a tree
// with an old dist, so the gap stays hidden (fix wave of plan 12i, item 13). This test holds the graph to the
// examples, so a new import of an example cannot drift from it.

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Each workspace package by name (pnpm-workspace.yaml: packages, examples, apps). */
const WORKSPACE = new Map<string, Manifest>();
for (const group of ["packages", "examples", "apps"])
  for (const e of readdirSync(join(REPO, group), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let text: string;
    try {
      text = readFileSync(join(REPO, group, e.name, "package.json"), "utf8");
    } catch {
      continue;
    }
    const m = JSON.parse(text) as Manifest;
    WORKSPACE.set(m.name, m);
  }

/** The workspace packages that a manifest names, as turbo's ^build reads them. */
function workspaceDeps(m: Manifest): string[] {
  const all = { ...m.dependencies, ...m.devDependencies, ...m.optionalDependencies };
  return Object.keys(all).filter((n) => WORKSPACE.has(n));
}

/** The packages that `^build` builds for a package: its workspace deps, and theirs. */
function closure(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  const todo = [...names];
  while (todo.length > 0) {
    const n = todo.pop() as string;
    if (out.has(n)) continue;
    out.add(n);
    const m = WORKSPACE.get(n);
    if (m) todo.push(...workspaceDeps(m));
  }
  return out;
}

/** The dependsOn list of the CLI test task. Turbo reads JSONC; the file holds whole-line comments only. */
function cliTestDependsOn(): string[] {
  const text = readFileSync(join(PKG, "turbo.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const turbo = JSON.parse(text) as { tasks: { test: { dependsOn: string[] } } };
  return turbo.tasks.test.dependsOn;
}

/** Each package whose dist exists when the CLI test starts. */
function builtBeforeTheCliTest(): Set<string> {
  const cli = WORKSPACE.get("@authtempo/cli") as Manifest;
  const roots = workspaceDeps(cli);
  for (const dep of cliTestDependsOn()) {
    const [pkg, task] = dep.split("#");
    if (pkg === undefined || task === undefined) continue;
    const m = WORKSPACE.get(pkg);
    if (m === undefined) continue;
    // `<pkg>#build` builds the package and, by its own ^build, its deps.
    if (task === "build") roots.push(pkg);
    // `<example>#test` waits for ^build of the example: its deps.
    else roots.push(...workspaceDeps(m));
  }
  return closure(roots);
}

describe("the CLI test graph builds each package a scaffold imports (plan 12i fix wave)", () => {
  const built = builtBeforeTheCliTest();
  for (const stack of STACKS)
    it(`builds the workspace imports of the ${stack} example`, () => {
      const example = WORKSPACE.get(`authtempo-example-${STACK_INFO[stack].example}`);
      expect(example, STACK_INFO[stack].example).toBeDefined();
      const missing = workspaceDeps(example as Manifest).filter((n) => !built.has(n));
      expect(missing).toEqual([]);
    });
});
