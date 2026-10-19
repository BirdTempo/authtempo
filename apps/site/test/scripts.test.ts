import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE } from "../scripts/lib/paths.ts";

// Astro telemetry reads its switch from the environment only, so each script
// sets it before astro (astro.config.mjs has the reason).
const PREFIX = "ASTRO_TELEMETRY_DISABLED=1 ";
// wrangler sends usage metrics unless the environment turns them off; the
// smoke run and the dry run set the same variable in their spawn.
const WRANGLER_PREFIX = "WRANGLER_SEND_METRICS=false ";
const pkg = JSON.parse(readFileSync(`${SITE}package.json`, "utf8")) as {
  scripts: Record<string, string>;
};

/** Each simple command of each script that runs the tool, with its script name. */
function commandsOf(tool: string): { name: string; part: string }[] {
  const runs = new RegExp(`(^|\\s)${tool}(\\s|$)`);
  return Object.entries(pkg.scripts).flatMap(([name, script]) =>
    script
      .split(/&&|\|\||;|\{|\}/)
      .map((part) => part.trim())
      .filter((part) => runs.test(part))
      .map((part) => ({ name, part })),
  );
}

function expectPrefix(tool: string, prefix: string): void {
  const commands = commandsOf(tool);
  expect(commands.length).toBeGreaterThan(0);
  for (const { name, part } of commands)
    expect({ name, part, prefixed: part.startsWith(prefix) }).toEqual({
      name,
      part,
      prefixed: true,
    });
}

describe("the package scripts (plan 11a)", () => {
  it("turn off Astro telemetry before each astro command", () => {
    expectPrefix("astro", PREFIX);
  });

  it("turn off wrangler metrics before each wrangler command", () => {
    expectPrefix("wrangler", WRANGLER_PREFIX);
  });

  // The test script runs vitest after a failed check, so a unit-test failure
  // never hides behind a check failure, and it fails when either one fails.
  it("runs vitest after a failed check, and fails when either one fails", () => {
    // The test pins the order of plan 11e Task 3. build-agent runs right after
    // astro build and before any check, because the checks read its output.
    // --force: see the test "builds with --force" below.
    const build = `${PREFIX}astro build --force && node scripts/build-agent.ts && `;
    const script = pkg.scripts.test ?? "";
    expect(script.startsWith(build)).toBe(true);
    const rest = script.slice(build.length);
    expect(rest).toContain("node scripts/check.ts");
    expect(rest).toContain("vitest run");
    const run = (check: number, vitest: number) => {
      const stubbed = rest
        .replace("node scripts/check.ts", `(echo check; exit ${check})`)
        .replace("vitest run", `(echo vitest; exit ${vitest})`);
      const r = spawnSync("sh", ["-c", stubbed], { encoding: "utf8" });
      return { out: r.stdout.trim().split("\n"), failed: r.status !== 0 };
    };
    expect(run(1, 0)).toEqual({ out: ["check", "vitest"], failed: true });
    expect(run(0, 1)).toEqual({ out: ["check", "vitest"], failed: true });
    expect(run(0, 0)).toEqual({ out: ["check", "vitest"], failed: false });
  });

  // Plan 11b1 ruling 22. Astro keeps the rendered body of each .md page in
  // node_modules/.astro/data-store.json and does not clear it when an
  // integration option changes. On 2026-10-19 the new Expressive Code options
  // left 10 .md pages with a link to a stylesheet that the build no longer
  // writes. turbo --force does not clear that file; astro build --force does.
  // A cache is a speed tool, never evidence. So each script whose build feeds a
  // check uses --force: build, test, and preview:smoke. The mcp index copy and
  // the mcp tests read the dist of build. preview feeds no check, but a stale
  // store gives a reader 10 pages with no code stylesheet, so it uses --force too.
  // dev builds nothing.
  it("builds with --force in each script that runs astro build", () => {
    for (const name of ["build", "test", "preview:smoke", "preview"])
      expect({
        name,
        forced: (pkg.scripts[name] ?? "").startsWith(`${PREFIX}astro build --force && `),
      }).toEqual({
        name,
        forced: true,
      });
  });
});
