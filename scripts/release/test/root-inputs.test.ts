import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkChangesets } from "../src/check-changesets.ts";
import { REGISTER_FILE } from "../src/lib/deprecations.ts";
import { readChangesetConfig, releasedNames } from "../src/lib/released.ts";
import { summaryLine } from "../src/lib/report.ts";
import { ROOT_INPUTS, rootInputOf } from "../src/lib/root-inputs.ts";
import { readWorkspace } from "../src/lib/workspace.ts";

// ROOT_INPUTS of src/lib/root-inputs.ts (ruling 67 of plan 12j, Minor 1).
// check-changesets saw only the files inside a released folder, so a change
// of tsconfig.base.json or of the register needed no changeset. This test
// holds the list to each reader that the release has, so a new reader fails
// until its file has a row.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RELEASED = releasedNames(ROOT);
const PACKAGES = readWorkspace(ROOT).filter((p) => RELEASED.includes(p.name));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The fault of a file that changes the tarball of `name`, with no row that names it. */
function fault(path: string, name: string, reader: string): string | null {
  const row = rootInputOf(path);
  if (row === undefined) return `${path} (read by ${reader}) has no row in ROOT_INPUTS`;
  if (row.names !== "all" && !row.names.includes(name))
    return `${path} (read by ${reader}) has a row that does not name ${name}`;
  return null;
}

describe("ROOT_INPUTS", () => {
  it("names only released packages and paths that exist", () => {
    for (const row of ROOT_INPUTS) {
      expect(existsSync(join(ROOT, row.path)), row.path).toBe(true);
      if (row.names !== "all") for (const n of row.names) expect(RELEASED, row.path).toContain(n);
      expect(row.reason.trim(), row.path).not.toBe("");
    }
  });

  it("holds each file outside its package that a released build script runs", () => {
    expect(PACKAGES.length).toBe(RELEASED.length);
    const faults: string[] = [];
    let found = 0;
    for (const p of PACKAGES) {
      const build = (p.manifest.scripts as Record<string, string> | undefined)?.build ?? "";
      for (const m of build.matchAll(/\bnode\s+(\S+\.m?js)\b/g)) {
        const path = relative(ROOT, join(ROOT, p.dir, m[1] ?? ""));
        if (path.startsWith(`${p.dir}/`)) continue;
        found++;
        const f = fault(path, p.name, `the build of ${p.name}`);
        if (f !== null) faults.push(f);
      }
      // The tsconfig.json of the build and each config that it extends, outside the package.
      let config = join(p.dir, "tsconfig.json");
      while (existsSync(join(ROOT, config))) {
        const ext = /"extends":\s*"([^"]+)"/.exec(read(config))?.[1];
        if (ext === undefined) break;
        config = relative(ROOT, join(ROOT, dirname(config), ext));
        if (config.startsWith(`${p.dir}/`)) continue;
        found++;
        const f = fault(config, p.name, `the tsconfig.json of ${p.name}`);
        if (f !== null) faults.push(f);
      }
    }
    // The clean-dist script and tsconfig.base.json of each package, and two version builds.
    expect(found).toBeGreaterThanOrEqual(2 * RELEASED.length + 2);
    expect(faults).toEqual([]);
  });

  it("holds each file of the repository that prepare reads", () => {
    const sources = [
      read("scripts/release/src/prepare.ts"),
      read("scripts/release/src/lib/released.ts"),
    ].join("\n");
    const paths = [
      ...[...sources.matchAll(/join\(root, "([^"]+)"\)/g)].map((m) => m[1] ?? ""),
      REGISTER_FILE,
    ].filter((p) => p !== ".git");
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "release/repository.json",
        "LICENSE",
        ".changeset/config.json",
      ]),
    );
    const faults = paths.flatMap((p) => {
      const row = rootInputOf(p);
      return row === undefined ? [`${p} (read by prepare) has no row in ROOT_INPUTS`] : [];
    });
    expect(faults).toEqual([]);
  });

  // Ruling 77 of plan 12j: the row counted each key, so a new unreleased
  // package in ignore needed a changeset of every released package.
  it("counts only the fixed group of .changeset/config.json", () => {
    const path = ".changeset/config.json";
    const text = read(path);
    const config = JSON.parse(text) as { fixed: string[][]; ignore: string[] };
    const check = (head: object) =>
      checkChangesets({
        changed: [{ path, base: text, head: `${JSON.stringify(head, null, 2)}\n` }],
        changesets: [],
        released: RELEASED,
        dirs: {},
        files: {},
        commits: 1,
        version: "0.1.0",
      });
    // A new unreleased package: no tarball changes, and no changeset is needed.
    const ignore = check({ ...config, ignore: [...config.ignore, "authtempo-example-new"] });
    expect(summaryLine(ignore)).toBe(
      "check-changesets: PASS changed=0 covered=0 exempt=1 empty=0 failures=0",
    );
    // A released package leaves the group: each released name needs a changeset.
    const fewer = check({ ...config, fixed: [(config.fixed[0] ?? []).slice(1)] });
    expect(fewer.failures).toEqual(
      RELEASED.map((n) => `${n} changes and no changeset names it: ${path} (fixed)`),
    );
    // The release reads only fixed[0] of the file as the released list.
    expect(RELEASED).toEqual(readChangesetConfig(ROOT).fixed[0]);
    expect(rootInputOf(path)?.keys).toEqual(["fixed"]);
  });

  it("holds each example that the CLI build renders, and each migration source", () => {
    const examples = [
      ...read("packages/cli/src/stacks.ts").matchAll(/^\s+example: "([^"]+)",$/gm),
    ].map((m) => m[1] ?? "");
    expect(examples.length).toBeGreaterThan(0);
    const faults = examples.flatMap((e) => {
      const f = fault(`examples/${e}/src/x.ts`, "@authtempo/cli", "the init templates of the CLI");
      return f === null ? [] : [f];
    });
    const sources = JSON.parse(read("release/migration-sources.json")) as Record<
      string,
      { from: string }
    >;
    for (const [adapter, { from }] of Object.entries(sources)) {
      const f = fault(
        `${from}/0001_schema_v1.sql`,
        `@authtempo/${adapter}`,
        `the build of ${adapter}`,
      );
      if (f !== null) faults.push(f);
    }
    expect(faults).toEqual([]);
  });
});
