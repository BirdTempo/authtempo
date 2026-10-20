import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChangedFile,
  checkChangesets,
  parseChangeset,
  readInput,
} from "../src/check-changesets.ts";
import { summaryLine } from "../src/lib/report.ts";
import { makeRepo, type Repo } from "./support/git-repo.ts";

const read = (name: string) =>
  readFileSync(new URL(`./fixtures/changesets/${name}`, import.meta.url), "utf8");
const changeset = (name: string) => ({ file: `.changeset/${name}`, text: read(name) });
const manifest = (base: string, head: string): ChangedFile => ({
  path: "packages/core/package.json",
  base: read(`manifests/${base}.json`),
  head: read(`manifests/${head}.json`),
});

const released = [
  "@authtempo/cli",
  "@authtempo/compat-better-auth",
  "@authtempo/core",
  "@authtempo/import",
];
const dirs = {
  "@authtempo/cli": "packages/cli",
  "@authtempo/compat-better-auth": "packages/compat-better-auth",
  "@authtempo/core": "packages/core",
  "@authtempo/import": "packages/import",
  "authtempo-example-node": "examples/node",
};
const run = (changed: ChangedFile[], names: string[], commits = 1) =>
  checkChangesets({ changed, changesets: names.map(changeset), released, dirs, commits });
const paths = (...list: string[]) => list.map((path) => ({ path }));

let repo: Repo | undefined;
afterEach(() => repo?.remove());

/**
 * A repository on main with the released package @fixture/a and the unreleased
 * package @fixture/u, then the branch "work".
 */
function fixtureRepo(): Repo {
  const r = makeRepo();
  r.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  r.write(
    ".changeset/config.json",
    JSON.stringify({ fixed: [["@fixture/a"]], linked: [], ignore: ["@fixture/u"] }),
  );
  r.write(
    "packages/a/package.json",
    '{ "name": "@fixture/a", "version": "0.0.0", "files": ["dist"] }\n',
  );
  r.write("packages/a/src/foo.ts", "export const foo = 1;\n");
  r.write("packages/u/package.json", '{ "name": "@fixture/u", "version": "0.0.0" }\n');
  r.commit("first");
  r.git(["checkout", "--quiet", "-b", "work"]);
  return r;
}

describe("check-changesets", () => {
  it("passes a source change with a changeset that names the package", () => {
    const r = run(paths("packages/core/src/x.ts"), ["core-patch.md"]);
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-changesets: PASS changed=1 covered=1 exempt=0 empty=0 failures=0",
    );
    expect(parseChangeset(read("core-minor-single-quote.md"))).toEqual({
      releases: [{ name: "@authtempo/core", bump: "minor" }],
      body: "Add the zod schema for the session.",
    });
  });

  it("fails a source change with no changeset", () => {
    const r = run(paths("packages/core/src/x.ts", "docs/notes.md"), []);
    expect(r.failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/src/x.ts",
    ]);
    expect(summaryLine(r)).toBe(
      "check-changesets: FAIL changed=1 covered=0 exempt=0 empty=0 failures=1",
    );
  });

  it("exempts a test, a proof, a typetest, a fixture, and the README", () => {
    const r = run(
      paths(
        "packages/core/test/a.test.ts",
        "packages/cli/proof/pack-files.mjs",
        "packages/compat-better-auth/typetest/a.ts",
        "packages/import/test/fixtures/a.csv",
        "packages/core/README.md",
      ),
      [],
    );
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-changesets: PASS changed=0 covered=0 exempt=5 empty=0 failures=0",
    );
  });

  it("needs a changeset for a runtime key of package.json", () => {
    expect(run([manifest("base", "dependencies")], []).failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/package.json (dependencies)",
    ]);
    expect(summaryLine(run([manifest("base", "dependencies")], ["core-patch.md"]))).toBe(
      "check-changesets: PASS changed=1 covered=1 exempt=0 empty=0 failures=0",
    );
    expect(() => run([{ path: "packages/core/package.json" }], [])).toThrow(
      "packages/core/package.json: the input needs the base and head texts of the manifest",
    );
    for (const head of ["dev-dependencies", "scripts"])
      expect(summaryLine(run([manifest("base", head)], []))).toBe(
        "check-changesets: PASS changed=0 covered=0 exempt=1 empty=0 failures=0",
      );
  });

  it("allows an empty changeset with a reason", () => {
    expect(summaryLine(run(paths("packages/core/test/a.test.ts"), ["empty-reason.md"]))).toBe(
      "check-changesets: PASS changed=0 covered=0 exempt=1 empty=1 failures=0",
    );
    const source = run(paths("packages/core/src/x.ts"), ["empty-reason.md"]);
    expect(source.failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/src/x.ts",
    ]);
    expect(summaryLine(source)).toBe(
      "check-changesets: FAIL changed=1 covered=0 exempt=0 empty=1 failures=1",
    );
  });

  it("refuses an empty changeset with no reason", () => {
    const r = run(paths("packages/core/test/a.test.ts"), [
      "empty-no-reason.md",
      "empty-other-body.md",
    ]);
    expect(r.failures).toEqual([
      '.changeset/empty-no-reason.md names no package and has no line "No release: <reason>"',
      '.changeset/empty-other-body.md names no package and has no line "No release: <reason>"',
    ]);
  });

  it("refuses a changeset that names an unreleased package", () => {
    expect(run(paths("examples/node/src/app.ts"), ["unreleased.md"]).failures).toEqual([
      ".changeset/unreleased.md names authtempo-example-node, which is not a released package",
    ]);
  });

  it("refuses a changeset whose body starts with a plan number", () => {
    expect(run(paths("packages/core/src/x.ts"), ["plan-number.md"]).failures).toEqual([
      ".changeset/plan-number.md: the body starts with a plan number; a changelog entry names the change, not the plan",
    ]);
  });

  it("refuses a frontmatter line of another form", () => {
    expect(() => parseChangeset("Fix the help text.\n")).toThrow('line 1 is not "---"');
    expect(() => parseChangeset('---\n"@authtempo/core": patch\n')).toThrow(
      'the frontmatter has no closing "---" line',
    );
    expect(() => parseChangeset(read("bad-line.md"))).toThrow(
      'line 3: "@authtempo/cli: patch" is not "<name>": major|minor|patch',
    );
    expect(run(paths("packages/cli/src/x.ts"), ["bad-line.md"]).failures).toEqual([
      '.changeset/bad-line.md: line 3: "@authtempo/cli: patch" is not "<name>": major|minor|patch',
      "@authtempo/cli changes and no changeset names it: packages/cli/src/x.ts",
    ]);
  });

  it("fails when it reads zero changed files on a branch with commits", () => {
    const empty = run([], [], 3);
    expect(empty.failures).toEqual([
      "read 0 changed files on a branch with 3 commits since the merge base",
    ]);
    expect(summaryLine(empty)).toMatch(/^check-changesets: FAIL changed=0 /);

    // The entry with a base equal to HEAD reads no commit and no change.
    repo = makeRepo();
    repo.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    repo.write(
      ".changeset/config.json",
      JSON.stringify({ fixed: [["@fixture/a"]], linked: [], ignore: [] }),
    );
    repo.write("packages/a/package.json", JSON.stringify({ name: "@fixture/a", version: "0.0.0" }));
    repo.commit("first");
    const head = checkChangesets(readInput(repo.root, "HEAD"));
    expect(summaryLine(head)).toBe(
      "check-changesets: PASS changed=0 covered=0 exempt=0 empty=0 failures=0",
    );
    expect(head.notes).toEqual(["no change since the merge base"]);
  });

  it("needs a changeset when a move takes a file out of a released package", () => {
    repo = fixtureRepo();
    mkdirSync(join(repo.root, "packages/u/src"));
    repo.git(["mv", "packages/a/src/foo.ts", "packages/u/src/foo.ts"]);
    repo.commit("move foo out");
    expect(checkChangesets(readInput(repo.root, "main")).failures).toEqual([
      "@fixture/a changes and no changeset names it: packages/a/src/foo.ts",
    ]);
  });

  it("reads only the changesets that are new since the merge base", () => {
    repo = makeRepo();
    repo.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    repo.write(
      ".changeset/config.json",
      JSON.stringify({ fixed: [["@fixture/a"]], linked: [], ignore: [] }),
    );
    repo.write(".changeset/README.md", "# Changesets\n");
    repo.write(".changeset/old.md", '---\n"@fixture/a": patch\n---\n\nFix the old bug.\n');
    repo.write("packages/a/package.json", '{ "name": "@fixture/a", "version": "0.0.0" }\n');
    repo.write("packages/a/src/x.ts", "export const x = 1;\n");
    repo.commit("first");
    repo.git(["checkout", "--quiet", "-b", "work"]);
    // A changeset that is already on main covers an earlier change, not this one.
    repo.write("packages/a/src/x.ts", "export const x = 2;\n");
    repo.write(
      "packages/a/package.json",
      '{ "name": "@fixture/a", "version": "0.0.0", "engines": { "node": ">=22" } }\n',
    );
    repo.write(".changeset/README.md", '---\n"@fixture/a": patch\n---\n\nNot a changeset.\n');
    expect(checkChangesets(readInput(repo.root, "main")).failures).toEqual([
      "@fixture/a changes and no changeset names it: packages/a/package.json (engines), packages/a/src/x.ts",
    ]);
    repo.write(".changeset/new.md", '---\n"@fixture/a": patch\n---\n\nFix the new bug.\n');
    expect(summaryLine(checkChangesets(readInput(repo.root, "main")))).toBe(
      "check-changesets: PASS changed=2 covered=2 exempt=0 empty=0 failures=0",
    );
  });
});
