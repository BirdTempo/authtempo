import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CONTRIBUTING.md at the repository root (owner decision 5 of 2026-10-14,
// spec 33 item 14). The test reads the real file and the root package.json.
const ROOT = new URL("../../../", import.meta.url);
const TEXT = readFileSync(new URL("CONTRIBUTING.md", ROOT), "utf8");
const ROOT_PACKAGE = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
  scripts: Record<string, string>;
  packageManager: string;
  engines: { node: string };
};

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
  const [tool, name] = line.trim().split(/\s+/);
  if (tool !== "pnpm") return null;
  if (name === "turbo")
    return line.trim().startsWith("pnpm turbo run ") && line.trim().endsWith(" --force")
      ? null
      : `${line.trim()}: a turbo line is pnpm turbo run ... --force`;
  if (name !== undefined && (PNPM_COMMANDS.has(name) || Object.hasOwn(scripts, name))) return null;
  return `${line.trim()}: ${name ?? "(none)"} is not a root script`;
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
    expect(fenceLines(section("Test with the cache off"))).toContain(
      "pnpm turbo run test typecheck typecheck:configs --force",
    );
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

  it("links SECURITY.md for a fault", () => {
    expect(TEXT).toContain("[`SECURITY.md`](SECURITY.md)");
    expect(TEXT).toContain("Do not open a public issue for a fault.");
  });
});
