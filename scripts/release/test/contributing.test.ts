import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_FLOOR } from "../src/lib/release-facts.ts";
import { EVIDENCE_RUN } from "../src/release-check.ts";

// CONTRIBUTING.md at the repository root (owner decision 5 of 2026-10-14,
// spec 33 item 14). The test reads the real file and the root package.json.
const ROOT = new URL("../../../", import.meta.url);
const TEXT = readFileSync(new URL("CONTRIBUTING.md", ROOT), "utf8");
const ROOT_PACKAGE = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
  scripts: Record<string, string>;
  packageManager: string;
  engines: { node: string };
};
const RELEASE_PACKAGE = JSON.parse(
  readFileSync(new URL("scripts/release/package.json", ROOT), "utf8"),
) as { engines: { node: string } };
/**
 * The task names of turbo.json, which holds comments. A root task "//#<name>"
 * runs as <name>. A task of one package, "<package>#<name>", defines no task
 * for the other packages, so it stays out.
 */
const TURBO_TASKS = Object.keys(
  (
    JSON.parse(readFileSync(new URL("turbo.json", ROOT), "utf8").replace(/^\s*\/\/.*$/gm, "")) as {
      tasks: Record<string, unknown>;
    }
  ).tasks,
).map((t) => t.replace(/^\/\/#/, ""));
/** The wrapper of the test servers, which runs the command after "--" (scripts/test-servers.mjs). */
const SERVERS_RUN = "node scripts/test-servers.mjs run -- ";

/** The text of one `## ` section, without its heading. */
function section(heading: string): string {
  const start = TEXT.indexOf(`\n## ${heading}\n`);
  expect(start, `the section "${heading}"`).toBeGreaterThan(-1);
  const end = TEXT.indexOf("\n## ", start + 1);
  return TEXT.slice(start + heading.length + 5, end === -1 ? undefined : end);
}

/** Each line of each fenced block of the file. */
function fenceLines(text: string): string[] {
  return [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].flatMap((m) =>
    (m[1] ?? "").split("\n").filter((line) => line.trim() !== ""),
  );
}

/** pnpm's own commands that the guide names. Every other `pnpm <name>` is a root script. */
const PNPM_COMMANDS = new Set(["install"]);

/**
 * The fault of a `pnpm` line of a fence, or null. A line is a root script,
 * a pnpm command of PNPM_COMMANDS, or a `pnpm turbo run` with the cache off.
 */
function commandFault(line: string, scripts: Record<string, string>): string | null {
  // The wrapper of the test servers runs the command after "--", which keeps its own rules.
  if (line.trim().startsWith(SERVERS_RUN))
    return commandFault(line.trim().slice(SERVERS_RUN.length), scripts);
  const [tool, name] = line.trim().split(/\s+/);
  if (tool !== "pnpm") return null;
  if (name === "turbo")
    return line.trim().startsWith("pnpm turbo run ") && /\s--force(\s|$)/.test(line)
      ? null
      : `${line.trim()}: a turbo line is pnpm turbo run ... --force`;
  if (name !== undefined && (PNPM_COMMANDS.has(name) || Object.hasOwn(scripts, name))) return null;
  return `${line.trim()}: ${name ?? "(none)"} is not a root script`;
}

/**
 * Each path of the repository that the guide names: a code span with a slash,
 * and each link target. A bare name such as `CHANGELOG.md` is the file of each
 * package, not one path.
 */
function namedPaths(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] ?? "");
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
  return [...new Set([...spans.filter((s) => s.includes("/")), ...links])];
}

/**
 * The paths that a later task of plan 12j adds. The exists rule skips each
 * one. An entry whose file exists fails as stale, so the task that adds the
 * file removes its entry. check-workflows had the same form until Task 14
 * removed its last entry.
 */
// Task 13b added docs/release/RUNBOOK.md, so the list is empty (plan 12j).
const LATER: { path: string; task: string }[] = [];

/** The fault of each named path: a missing file, or a stale LATER entry. */
function pathFaults(
  paths: readonly string[],
  exists: (path: string) => boolean,
  later: readonly { path: string; task: string }[] = LATER,
): string[] {
  const skip = new Set(later.map((l) => l.path));
  const faults = paths.filter((p) => !skip.has(p) && !exists(p)).map((p) => `${p} does not exist`);
  for (const { path, task } of later)
    if (exists(path)) faults.push(`the file ${path} exists; ${task} removes its entry from LATER`);
  return faults;
}

describe("CONTRIBUTING.md", () => {
  it("has the six sections in order", () => {
    const headings = [...TEXT.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Build",
      "Test with the cache off",
      "The evidence rule",
      "The records rule",
      "The commit shape",
      "No publish",
    ]);
  });

  it("names only commands that exist", () => {
    const lines = fenceLines(TEXT);
    expect(lines.filter((l) => l.startsWith("pnpm ")).length).toBeGreaterThan(0);
    expect(
      lines.map((l) => commandFault(l, ROOT_PACKAGE.scripts)).filter((f) => f !== null),
    ).toEqual([]);
    // The command of the evidence run of release-check, through the test
    // servers: a direct turbo run stops each test that needs a server (ruling
    // 64 of plan 12j, Minor 1). The docker compose step left with ruling 50.
    const test = fenceLines(section("Test with the cache off"));
    expect(test).toEqual([EVIDENCE_RUN.join(" "), "node scripts/test-servers.mjs down"]);
    expect(fenceLines(TEXT).filter((l) => /\bdocker\b/.test(l))).toEqual([]);
    // Each task of the turbo line is a task of turbo.json (ruling 26 of plan 12j, L7).
    const tasks = (test[0] ?? "")
      .replace(/^.*pnpm turbo run /, "")
      .split(" ")
      .filter((w) => !w.startsWith("--"));
    expect(tasks).toEqual(["test", "typecheck", "typecheck:configs"]);
    for (const task of tasks) expect(TURBO_TASKS, task).toContain(task);
    // The fault form of each rule, so the test can fail on each.
    expect(commandFault("pnpm turbo run test", ROOT_PACKAGE.scripts)).toBe(
      "pnpm turbo run test: a turbo line is pnpm turbo run ... --force",
    );
    expect(commandFault("pnpm deploy", ROOT_PACKAGE.scripts)).toBe(
      "pnpm deploy: deploy is not a root script",
    );
  });

  it("states the versions of the root package.json", () => {
    // One source each: packageManager and engines. The guide names the same values.
    const pnpm = ROOT_PACKAGE.packageManager.replace(/^pnpm@/, "");
    const node = ROOT_PACKAGE.engines.node.replace(/^>=/, "");
    expect(section("Build")).toContain(`pnpm ${pnpm}`);
    expect(section("Build")).toContain(`Node ${node} or newer`);
    // The scripts are .ts files that Node runs by type stripping, so the
    // floor of the root and of the release package is NODE_FLOOR (ruling 64 of plan 12j, Low 8).
    expect(ROOT_PACKAGE.engines.node).toBe(`>=${NODE_FLOOR}`);
    expect(RELEASE_PACKAGE.engines.node).toBe(`>=${NODE_FLOOR}`);
  });

  it("states the evidence rule", () => {
    const rule = section("The evidence rule");
    for (const text of ["0 cached", "summary line", "break"]) expect(rule).toContain(text);
  });

  it("states the records rule and the changeset rule", () => {
    const records = section("The records rule");
    for (const text of [
      "`CHANGELOG.md`",
      "`docs/security/advisories.md`",
      "migration",
      "append-only",
    ])
      expect(records).toContain(text);
    expect(section("The commit shape")).toContain("`pnpm changeset`");
  });

  it("forbids a publish", () => {
    const rule = section("No publish");
    for (const text of [
      "Do not publish",
      "`npm publish`",
      "`pnpm publish`",
      "`changeset publish`",
      "`docs/release/RUNBOOK.md`",
    ])
      expect(rule).toContain(text);
  });

  it("names only paths that exist, or that a later task adds", () => {
    const paths = namedPaths(TEXT);
    expect(paths).toContain("docs/security/advisories.md");
    expect(paths).toContain("docs/release/RUNBOOK.md");
    expect(paths).toContain("SECURITY.md");
    expect(pathFaults(paths, (p) => existsSync(new URL(p, ROOT)))).toEqual([]);
    // The fault form of each rule, so the test can fail on each.
    expect(pathFaults(["docs/no-such-file.md"], () => false)).toEqual([
      "docs/no-such-file.md does not exist",
    ]);
    expect(pathFaults([], () => true, [{ path: "docs/x.md", task: "Task 99" }])).toEqual([
      "the file docs/x.md exists; Task 99 removes its entry from LATER",
    ]);
  });

  it("links SECURITY.md for a fault", () => {
    expect(TEXT).toContain("[`SECURITY.md`](SECURITY.md)");
    expect(TEXT).toContain("Do not open a public issue for a fault.");
  });
});
