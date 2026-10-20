import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extraFiles,
  isUnpublished,
  nextSteps,
  renderStack,
  rewrite,
  STACK_INFO,
  STACKS,
  type Stack,
  type TemplateFile,
  UNPUBLISHED_NOTE,
} from "../src/templates.js";
import { assertFreshBuild, PKG, REPO, runBin } from "./support/bin.js";

// Each scaffold of `authtempo init` is compiled and runs its own test in a
// folder inside the workspace (plan 11c). Its node_modules is a link to the
// node_modules of the example it copies: the scaffold is that example, so
// the link resolves every import. The Postgres stacks need docker compose.

/** The version of the first release: `changeset version` writes it into each package of the group. */
const RELEASED = "0.1.0";

interface Manifest {
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}
const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const fileOf = (files: TemplateFile[], path: string): string => {
  const f = files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`the render has no ${path}`);
  return f.text;
};

/**
 * Each reference of a scaffold manifest that an app cannot install from the
 * registry at `version`: a workspace: range, or a workspace name or an
 * @authtempo name outside the fixed group, or a group name at another version.
 */
function unreleasedRefs(
  pkg: Manifest,
  group: ReadonlySet<string>,
  workspace: ReadonlySet<string>,
  version: string,
): string[] {
  const found: string[] = [];
  for (const key of DEPENDENCY_KEYS)
    for (const [dep, range] of Object.entries((pkg[key] ?? {}) as Record<string, string>)) {
      if (range.startsWith("workspace:")) found.push(`${key} ${dep}: ${range}`);
      else if (group.has(dep)) {
        if (range !== version) found.push(`${key} ${dep}: ${range}, not ${version}`);
      } else if (workspace.has(dep) || dep.startsWith("@authtempo/"))
        found.push(`${key} ${dep}: outside the fixed group`);
    }
  return found;
}

describe("the scaffold after publication (plan 12j)", () => {
  it("reads the version only", () => {
    expect(isUnpublished("0.0.0")).toBe(true);
    expect(isUnpublished("0.1.0")).toBe(false);
    // The owner's release branch after `changeset version`: main keeps private: true.
    const manifest = { private: true, version: "0.1.0" };
    expect(isUnpublished(manifest.version)).toBe(false);
  });

  it("adds the CLI as a dev dependency when published", () => {
    const text = readFileSync(join(REPO, "examples/node/package.json"), "utf8");
    const published = JSON.parse(rewrite("node", "package.json", text, "0.1.0", true)) as Manifest;
    expect(published.devDependencies?.["@authtempo/cli"]).toBe("0.1.0");
    const unpublished = JSON.parse(
      rewrite("node", "package.json", text, "0.0.0", false),
    ) as Manifest;
    expect(unpublished.devDependencies).not.toHaveProperty("@authtempo/cli");
  });

  it("calls pnpm exec authtempo in the next steps when published", () => {
    expect(nextSteps("workers-d1", true)).toEqual([
      "pnpm install",
      "cp .dev.vars.example .dev.vars",
      "pnpm exec authtempo migrate --target d1",
      "pnpm dev",
    ]);
    expect(nextSteps("workers-postgres", true)).toContain(
      "pnpm exec authtempo migrate --target postgres",
    );
    for (const stack of STACKS) {
      const readme = fileOf(extraFiles(stack, true), "README.md");
      expect(readme, stack).not.toContain(UNPUBLISHED_NOTE);
      expect(readme, stack).not.toContain("/path/to/authtempo");
      for (const step of nextSteps(stack, true)) expect(step, stack).not.toMatch(/^authtempo /);
    }
  });

  it("keeps the node /path/to/authtempo form and the note when unpublished", () => {
    expect(nextSteps("workers-d1", false)).toEqual([
      "pnpm install",
      "cp .dev.vars.example .dev.vars",
      "authtempo migrate --target d1",
      "pnpm dev",
    ]);
    for (const stack of STACKS) {
      const readme = fileOf(extraFiles(stack, false), "README.md");
      expect(readme, stack).toContain(UNPUBLISHED_NOTE);
      expect(readme, stack).toContain("node /path/to/authtempo/packages/cli/dist/bin/authtempo.js");
    }
  });

  it("renders both branches for each stack, which differ only in the declared lines", () => {
    for (const stack of STACKS) {
      const before = renderStack(stack, REPO, "0.0.0");
      const after = renderStack(stack, REPO, RELEASED);
      expect(
        after.map((f) => f.path),
        stack,
      ).toEqual(before.map((f) => f.path));
      for (const f of before) {
        const next = fileOf(after, f.path);
        if (f.path === "package.json") {
          const pkg = JSON.parse(next) as Manifest;
          expect(pkg.devDependencies?.["@authtempo/cli"], stack).toBe(RELEASED);
          delete pkg.devDependencies?.["@authtempo/cli"];
          // The rewrite of each workspace:* writes the version: 0.0.0 before, RELEASED after.
          const expected = JSON.parse(f.text) as Manifest;
          for (const key of DEPENDENCY_KEYS) {
            const deps = expected[key] as Record<string, string> | undefined;
            if (deps)
              for (const [k, v] of Object.entries(deps)) if (v === "0.0.0") deps[k] = RELEASED;
          }
          expect(pkg, stack).toEqual(expected);
        } else if (f.path === "README.md")
          expect(next, stack).toBe(
            f.text
              .replace(`${UNPUBLISHED_NOTE}\n\n`, "")
              .replaceAll("Run `authtempo ", "Run `pnpm exec authtempo "),
          );
        else expect(next, `${stack} ${f.path}`).toBe(f.text);
      }
    }
  });

  it("names only the fixed group at the group version when published", () => {
    // .changeset/config.json is the one list of the released packages (spec 33).
    // check-packages holds one version in the group, so the CLI version is the group version.
    const config = JSON.parse(readFileSync(join(REPO, ".changeset/config.json"), "utf8")) as {
      fixed: string[][];
      ignore: string[];
    };
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { name: string };
    const group = new Set(config.fixed[0] ?? []);
    expect(group.has("@authtempo/cli")).toBe(true);
    // ignore holds every workspace package outside the group (check-packages).
    const workspace = new Set([...group, ...config.ignore, root.name]);
    for (const stack of STACKS) {
      const pkg = JSON.parse(
        fileOf(renderStack(stack, REPO, RELEASED), "package.json"),
      ) as Manifest;
      expect(unreleasedRefs(pkg, group, workspace, RELEASED), stack).toEqual([]);
    }
    expect(
      unreleasedRefs(
        {
          dependencies: { "@authtempo/core": "workspace:*", "@authtempo/sdk-conformance": "0.1.0" },
          devDependencies: { "@authtempo/cli": "^0.1.0", "authtempo-example-node": "0.1.0" },
        },
        group,
        workspace,
        RELEASED,
      ),
    ).toEqual([
      "dependencies @authtempo/core: workspace:*",
      "dependencies @authtempo/sdk-conformance: outside the fixed group",
      "devDependencies @authtempo/cli: ^0.1.0, not 0.1.0",
      "devDependencies authtempo-example-node: outside the fixed group",
    ]);
  });
});

/** The lines that each stack's own test prints when it passes. */
const PASSES: Readonly<Record<Stack, readonly string[]>> = {
  // The tests line with its label: a bare count also matches the files line (plan 11d Task 14 review, L3).
  // Plan 12h ruling 13 adds observe-flush.test.ts with two tests to each Workers example.
  "workers-d1": ["Test Files  3 passed (3)", "Tests  5 passed (5)"],
  // The plan 12i fix wave adds the after-answer test to sign-in.test.ts of the Postgres example.
  "workers-postgres": [
    "Test Files  2 passed (2)",
    "Tests  5 passed (5)",
    "--dry-run: exiting now.",
  ],
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
    env: {
      ...process.env,
      PATH: `${join(dir, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      // The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
      WRANGLER_HIDE_BANNER: "true",
    },
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
