import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChangedFile,
  changesetStatus,
  checkChangesets,
  entry,
  parseChangeset,
  RUNTIME_KEYS,
  readInput,
  statusNotes,
} from "../src/check-changesets.ts";
import { changedFiles, mergeBase } from "../src/lib/git.ts";
import { summaryLine } from "../src/lib/report.ts";
import { rewrittenPaths } from "../src/rewrite-unpublished.ts";
import { makeRepo, makeUnrelatedRepo, type Repo } from "./support/git-repo.ts";

// The changesets CLI of the repository root, the one that writes each release branch.
const CHANGESET_BIN = fileURLToPath(
  new URL("../../../node_modules/@changesets/cli/bin.js", import.meta.url),
);
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
// The files field of each package, as on the tree of 2026-10-20.
const files: Record<string, readonly string[] | undefined> = {
  "@authtempo/cli": ["dist"],
  "@authtempo/compat-better-auth": ["dist", "migrations"],
  "@authtempo/core": ["dist"],
  "@authtempo/import": [
    "dist",
    "worker/README.md",
    "worker/wrangler.jsonc",
    "worker/src",
    "worker/proof",
  ],
  "authtempo-example-node": undefined,
};
const run = (
  changed: ChangedFile[],
  names: string[],
  commits = 1,
  packs = files,
  version = "0.0.0",
) =>
  checkChangesets({
    changed,
    changesets: names.map(changeset),
    released,
    dirs,
    files: packs,
    commits,
    version,
  });
const paths = (...list: string[]) => list.map((path) => ({ path }));

let repo: Repo | undefined;
afterEach(() => repo?.remove());

/**
 * A repository on main with the released package @fixture/a and the unreleased
 * package @fixture/u, then the branch "work". The config has the keys of the
 * real .changeset/config.json, so `changeset version` runs on it.
 */
function fixtureRepo(onMain: Record<string, string> = {}): Repo {
  const r = makeRepo();
  r.write("package.json", '{ "name": "fixture-root", "private": true }\n');
  r.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  r.write(
    ".changeset/config.json",
    JSON.stringify({
      changelog: "@changesets/cli/changelog",
      commit: false,
      fixed: [["@fixture/a"]],
      linked: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: ["@fixture/u"],
      privatePackages: { version: true, tag: false },
    }),
  );
  r.write(
    "packages/a/package.json",
    '{\n  "name": "@fixture/a",\n  "version": "0.0.0",\n  "private": true,\n  "files": ["dist", "CHANGELOG.md"]\n}\n',
  );
  r.write("packages/a/src/foo.ts", "export const foo = 1;\n");
  r.write(
    "packages/u/package.json",
    '{ "name": "@fixture/u", "version": "0.0.0", "private": true }\n',
  );
  for (const [path, text] of Object.entries(onMain)) r.write(path, text);
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

  it("exempts a file of UNPUBLISHED_FILES on the version branch only (ruling 47)", () => {
    // The import worker README is packed by the files field, as each skill of the MCP package is.
    const listed = "packages/import/worker/README.md";
    const other = "packages/import/worker/wrangler.jsonc";
    const step = (baseVersion: string | null, changed: string[]) =>
      checkChangesets({
        changed: paths(...changed),
        changesets: [],
        released,
        dirs,
        files,
        commits: 1,
        version: "0.1.0",
        baseVersion,
        unpublished: [listed],
      });
    // The version branch: the group moves from 0.0.0, and the note is rewritten with no changeset.
    const branch = step("0.0.0", [listed]);
    expect(branch.failures).toEqual([]);
    expect(summaryLine(branch)).toBe(
      "check-changesets: PASS changed=0 covered=0 exempt=1 empty=0 failures=0",
    );
    // Another packed file on the version branch still needs a changeset.
    expect(step("0.0.0", [listed, other]).failures).toEqual([
      `@authtempo/import changes and no changeset names it: ${other}`,
    ]);
    // On a branch that keeps the version, the listed file is a packed file like any other.
    for (const base of ["0.1.0", null])
      expect(step(base, [listed]).failures).toEqual([
        `@authtempo/import changes and no changeset names it: ${listed}`,
      ]);
  });

  it("needs a changeset for a file that the files field packs", () => {
    // The import tarball ships its worker proof and the worker README.
    const r = run(
      paths(
        "packages/import/worker/proof/pack-files.mjs",
        "packages/import/worker/README.md",
        "packages/core/src/test/x.ts",
      ),
      [],
    );
    expect(r.failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/src/test/x.ts",
      "@authtempo/import changes and no changeset names it: packages/import/worker/proof/pack-files.mjs, packages/import/worker/README.md",
    ]);
    expect(summaryLine(r)).toBe(
      "check-changesets: FAIL changed=3 covered=0 exempt=0 empty=0 failures=2",
    );
    // A package with no files field packs each file, so no row exempts a file of it.
    const all = run(paths("packages/core/test/a.test.ts"), [], 1, {
      ...files,
      "@authtempo/core": undefined,
    });
    expect(all.failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/test/a.test.ts",
    ]);
  });

  it("fails on a files entry that is not a plain path", () => {
    const r = run(paths("packages/core/test/a.test.ts"), [], 1, {
      ...files,
      "@authtempo/core": ["./dist", "types/*.d.ts"],
    });
    expect(r.failures).toEqual([
      '@authtempo/core: the files entry "./dist" is not a plain path; the check reads only a plain path, so it exempts no file of the package',
      '@authtempo/core: the files entry "types/*.d.ts" is not a plain path; the check reads only a plain path, so it exempts no file of the package',
      "@authtempo/core changes and no changeset names it: packages/core/test/a.test.ts",
    ]);
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

  it("needs a changeset for a change of type or imports", () => {
    expect(run([manifest("base", "type"), manifest("base", "imports")], []).failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/package.json (type), packages/core/package.json (imports)",
    ]);
  });

  it("needs a changeset for a new or a removed manifest", () => {
    const text = read("manifests/base.json");
    const all =
      "dependencies, peerDependencies, peerDependenciesMeta, optionalDependencies, exports, imports, main, types, type, bin, files, engines";
    expect(
      run([{ path: "packages/core/package.json", base: null, head: text }], []).failures,
    ).toEqual([
      `@authtempo/core changes and no changeset names it: packages/core/package.json (${all})`,
    ]);
    expect(
      run([{ path: "packages/core/package.json", base: text, head: null }], []).failures,
    ).toEqual([
      `@authtempo/core changes and no changeset names it: packages/core/package.json (${all})`,
    ]);
  });

  it("names the same runtime keys in the code and in .changeset/README.md", () => {
    const keys = [
      "dependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "optionalDependencies",
      "exports",
      "imports",
      "main",
      "types",
      "type",
      "bin",
      "files",
      "engines",
    ];
    expect([...RUNTIME_KEYS]).toEqual(keys);
    // The rule line of the README is the list that a contributor reads.
    const readme = readFileSync(
      fileURLToPath(new URL("../../../.changeset/README.md", import.meta.url)),
      "utf8",
    );
    const rule = readme
      .split("\n")
      .find((line) => line.includes("only when a runtime key changes"));
    // The pattern skips `package.json`, because a key name has no dot.
    expect([...(rule ?? "").matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1])).toEqual(keys);
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
    // The reason line is the first line of the body, so a late one does not count.
    const r = run(paths("packages/core/test/a.test.ts"), [
      "empty-no-reason.md",
      "empty-other-body.md",
      "empty-late-reason.md",
    ]);
    expect(r.failures).toEqual([
      '.changeset/empty-no-reason.md names no package and has no line "No release: <reason>"',
      '.changeset/empty-other-body.md names no package and has no line "No release: <reason>"',
      '.changeset/empty-late-reason.md names no package and has no line "No release: <reason>"',
    ]);
  });

  it("refuses a changeset that names an unreleased package", () => {
    expect(run(paths("examples/node/src/app.ts"), ["unreleased.md"]).failures).toEqual([
      ".changeset/unreleased.md names authtempo-example-node, which is not a released package",
    ]);
  });

  it("refuses a major bump while the group version is 0.x", () => {
    for (const version of ["0.0.0", "0.4.2"])
      expect(
        run(paths("packages/core/src/x.ts"), ["core-major.md"], 1, files, version).failures,
      ).toEqual([
        '.changeset/core-major.md names @authtempo/core as major; the group is at 0.x, so a break is a minor with a "Breaking:" line until the owner names 1.0.0',
      ]);
    // The entry reads the group version from the workspace.
    repo = fixtureRepo();
    repo.write("packages/a/src/foo.ts", "export const foo = 2;\n");
    repo.write(".changeset/break.md", '---\n"@fixture/a": major\n---\n\nRemove foo.\n');
    expect(checkChangesets(readInput(repo.root, "main")).failures).toEqual([
      '.changeset/break.md names @fixture/a as major; the group is at 0.x, so a break is a minor with a "Breaking:" line until the owner names 1.0.0',
    ]);
    // After the owner names 1.0.0, a break is a major.
    expect(
      summaryLine(run(paths("packages/core/src/x.ts"), ["core-major.md"], 1, files, "1.0.0")),
    ).toBe("check-changesets: PASS changed=1 covered=1 exempt=0 empty=0 failures=0");
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

  it("passes the release branch that changeset version writes", () => {
    repo = fixtureRepo({
      ".changeset/first.md": '---\n"@fixture/a": minor\n---\n\nAdd the first feature.\n',
    });
    // The real command removes the changeset, writes the changelog, and moves the version.
    repo.run(process.execPath, [CHANGESET_BIN, "version"]);
    repo.commit("version packages");
    expect(changedFiles(repo.root, mergeBase(repo.root, "main"))).toEqual([
      ".changeset/first.md",
      "packages/a/CHANGELOG.md",
      "packages/a/package.json",
    ]);
    expect(JSON.parse(readFileSync(join(repo.root, "packages/a/package.json"), "utf8"))).toEqual({
      name: "@fixture/a",
      version: "0.1.0",
      private: true,
      files: ["dist", "CHANGELOG.md"],
    });
    expect(summaryLine(checkChangesets(readInput(repo.root, "main")))).toBe(
      "check-changesets: PASS changed=0 covered=0 exempt=2 empty=0 failures=0",
    );
    // The entry reads the group version at the merge base and in the working tree.
    expect(readInput(repo.root, "main")).toMatchObject({ baseVersion: "0.0.0", version: "0.1.0" });
    // The version branch exempts each file that rewrite-unpublished writes (ruling 50 of plan 12j).
    expect(readInput(repo.root, "main").unpublished).toEqual(rewrittenPaths());
  });

  it("needs a changeset for a CHANGELOG.md below the package root", () => {
    expect(run(paths("packages/core/src/CHANGELOG.md"), []).failures).toEqual([
      "@authtempo/core changes and no changeset names it: packages/core/src/CHANGELOG.md",
    ]);
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

  it("counts no changeset that is on main at the merge base, also when it changes", () => {
    repo = fixtureRepo({
      ".changeset/old.md": '---\n"@fixture/a": patch\n---\n\nFix the old bug.\n',
    });
    repo.write("packages/a/src/foo.ts", "export const foo = 2;\n");
    repo.write(".changeset/old.md", '---\n"@fixture/a": patch\n---\n\nFix the old bug. \n');
    repo.commit("change foo and edit the old changeset");
    const r = checkChangesets(readInput(repo.root, "main"));
    expect(r.failures).toEqual([
      "@fixture/a changes and no changeset names it: packages/a/src/foo.ts",
    ]);
    expect(r.notes).toEqual([
      ".changeset/old.md is on main at the merge base, so it covers no change of this branch",
    ]);
  });

  it("runs changeset status from node_modules only, so it installs nothing", () => {
    // pnpm changeset status installed node_modules in a clone with none
    // (review of Task 6, n1). The check runs the binary itself, or skips the note.
    const bare = mkdtempSync(join(tmpdir(), "authtempo-changeset-status-"));
    try {
      expect(changesetStatus(bare, "f44660d9")).toEqual([
        "changeset status: skipped, node_modules/.bin/changeset is absent, and the check installs nothing",
      ]);
      expect(readdirSync(bare)).toEqual([]);

      // A stand-in binary writes its arguments, so the test reads the call.
      const bin = join(bare, "node_modules/.bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "changeset"),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/args.txt"\necho "No changesets present"\nexit 0\n',
      );
      chmodSync(join(bin, "changeset"), 0o755);
      expect(changesetStatus(bare, "f44660d9")).toEqual([
        "changeset status exited 0",
        "changeset status: No changesets present",
      ]);
      expect(readFileSync(join(bin, "args.txt"), "utf8")).toBe("status\n--since=f44660d9\n");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("prints the output of changeset status beside its exit code", () => {
    // The output of changeset status 3.0.3 on the tree of 2026-10-20.
    const notes = statusNotes({
      status: 1,
      stdout:
        "\u{1F98B}  changeset v3.0.3\n\nSome packages have been changed but no changesets were found. Run changeset add to resolve this error.\nIf this change doesn't need a release, run changeset add --empty.\n\u{1F98B}  Exited with code 1\n",
      stderr:
        "$ changeset status --since=f44660d96876e06953e3aab7c8d1a3baae2c2c1e\n[ELIFECYCLE] Command failed with exit code 1.\n",
    });
    expect(notes).toEqual([
      "changeset status exited 1",
      "changeset status: changeset v3.0.3",
      "changeset status: Some packages have been changed but no changesets were found. Run changeset add to resolve this error.",
      "changeset status: If this change doesn't need a release, run changeset add --empty.",
      "changeset status: Exited with code 1",
      "changeset status: $ changeset status --since=f44660d96876e06953e3aab7c8d1a3baae2c2c1e",
      "changeset status: [ELIFECYCLE] Command failed with exit code 1.",
    ]);
    expect(statusNotes({ status: null, stdout: "", stderr: "" })).toEqual([
      "changeset status exited with no code",
    ]);
  });

  it("prints a FAIL line with the reason when no merge base exists", () => {
    repo = makeUnrelatedRepo();
    expect(entry(repo.root, "main")).toEqual({
      lines: [
        "check-changesets: FAIL changed=0 covered=0 exempt=0 empty=0 failures=1",
        "  no merge base of HEAD and main; fetch the full history (fetch-depth: 0)",
      ],
      code: 1,
    });
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
