import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FEED_GLOBS, feedSources } from "../scripts/lib/feed.ts";
import { walk } from "../scripts/lib/files.ts";
import { REPO, SITE } from "../scripts/lib/paths.ts";
import { REPO_ROOT } from "../src/data/repo.ts";

/** A task of turbo.json: the keys that this test reads. */
interface Task {
  dependsOn?: string[];
  outputs?: string[];
  inputs?: string[];
}

// Turbo reads turbo.json as JSONC. The file holds comments on whole lines only.
const text = readFileSync(`${REPO}turbo.json`, "utf8").replace(/^\s*\/\/.*$/gm, "");
const tasks = (JSON.parse(text) as { tasks: Record<string, Task> }).tasks;
const inputs = tasks["@authtempo/site#build"]?.inputs ?? [];

/** The three root files that src/data/repo.ts reads. */
const ROOT_FILES = ["package.json", "SECURITY.md", "LICENSE"];

/** The repo paths that the inputs name after $TURBO_ROOT$/. */
const rootPatterns = inputs
  .filter((i) => i.startsWith("$TURBO_ROOT$/"))
  .map((i) => i.slice("$TURBO_ROOT$/".length));
/** The same, the three root files apart. */
const examplePatterns = rootPatterns.filter((p) => !ROOT_FILES.includes(p));

/** True when a repo path matches an input glob: `*` is one path segment part, `**` any depth. */
function matches(path: string, pattern: string): boolean {
  const re = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}

/**
 * Each ?raw import of a source file, by its repo path. The test reads each
 * page, layout, and data file under src/, which the build compiles.
 */
function rawImports(files: readonly { path: string; text: string }[]): string[] {
  const out = new Set<string>();
  for (const f of files)
    for (const m of f.text.matchAll(/(?:\bfrom|\bimport\s*\()\s*["']([^"']+)\?raw["']/g))
      out.add(relative(REPO, resolve(dirname(f.path), m[1] ?? "")));
  return [...out].sort();
}

const sources = walk(`${SITE}src/`, (p) => /\.(mdx|md|astro|ts|mjs|js)$/.test(p)).map((p) => ({
  path: p,
  text: readFileSync(p, "utf8"),
}));
/** The ?raw imports that read a file outside apps/site. */
const outside = rawImports(sources).filter((p) => !p.startsWith("apps/site/"));
/**
 * The files outside apps/site that build-feed.ts reads, on the fixture tree
 * and on this tree (plan 11b Task 7). This tree has no changelog yet, so the
 * fixture shows the changelog glob in use.
 */
const feedRead = [
  ...feedSources(`${SITE}test/fixtures/site/changelogs`),
  ...feedSources(REPO_ROOT),
];

describe("the inputs of the site build in turbo.json (plan 11b Task 5, rulings 21 and 22)", () => {
  // The root pages read the root package.json, SECURITY.md, and LICENSE
  // (src/data/repo.ts). Turbo hashes the files of the package only, so
  // without these inputs a cache hit serves a stale license or empty state.
  it("hashes the files of the package and the three root files that the pages read", () => {
    expect(inputs.slice(0, 4)).toEqual([
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

  // The docs import example files with ?raw, and no example is a dependency of
  // the site, so a cache hit would serve a sample older than its example.
  it("hashes each file outside apps/site that a ?raw import reads", () => {
    expect(outside.length).toBeGreaterThan(0);
    const missed = outside.filter((p) => !examplePatterns.some((g) => matches(p, g)));
    expect(missed).toEqual([]);
  });

  it("names no input outside apps/site that no ?raw import and no feed read reads", () => {
    const read = [...outside, ...feedRead];
    const unused = examplePatterns.filter((g) => !read.some((p) => matches(p, g)));
    expect(unused).toEqual([]);
  });

  // build-feed.ts reads the changelogs and the package names outside apps/site.
  // Without these inputs, a cache hit serves a feed older than its changelog.
  it("hashes each file that build-feed.ts reads, on the fixture tree and on this tree", () => {
    expect(inputs.slice(4, 6)).toEqual([
      "$TURBO_ROOT$/packages/*/CHANGELOG.md",
      "$TURBO_ROOT$/packages/*/package.json",
    ]);
    // The readers read only the files of FEED_GLOBS, so each glob must be an input.
    const globs = Object.values(FEED_GLOBS).map((g) => `$TURBO_ROOT$/${g}`);
    expect(globs.filter((g) => !inputs.includes(g))).toEqual([]);
    expect(feedRead.filter((p) => p.endsWith("CHANGELOG.md")).length).toBe(2);
    expect(feedSources(REPO_ROOT).length).toBeGreaterThan(0);
    const missed = feedRead.filter((p) => !rootPatterns.some((g) => matches(p, g)));
    expect(missed).toEqual([]);
  });

  it("reads a ?raw import, resolves it, and matches it to a glob", () => {
    const file = {
      path: `${SITE}src/content/docs/docs/a.mdx`,
      text: "import x from '../../../../../../examples/y/z.ts?raw';",
    };
    expect(rawImports([file])).toEqual(["examples/y/z.ts"]);
    expect(
      matches("examples/next/app/auth/[...path]/route.ts", "examples/next/app/auth/*/route.ts"),
    ).toBe(true);
    expect(
      matches("examples/next/app/auth/a/b/route.ts", "examples/next/app/auth/*/route.ts"),
    ).toBe(false);
    expect(matches("examples/a/src/b/c.ts", "examples/*/src/**")).toBe(true);
  });
});
