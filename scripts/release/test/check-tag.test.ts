import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTag, entry } from "../src/check-tag.ts";
import { summaryLine } from "../src/lib/report.ts";
import { makeRepo, type Repo } from "./support/git-repo.ts";

const tagAt = (tag: string, groupVersion: string, where: "main" | "release" | "neither") =>
  checkTag({ tag, groupVersion, onMain: where === "main", onReleaseBranch: where === "release" });

let repo: Repo | undefined;
afterEach(() => repo?.remove());

/**
 * A repository with one released package at `version`, as the tagged commit
 * of a release branch holds it after changeset version. The remote refs are
 * the refs that a checkout with fetch-depth 0 writes.
 */
function released(version: string): Repo {
  const r = makeRepo();
  r.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  r.write(
    ".changeset/config.json",
    JSON.stringify({ fixed: [["@authtempo/core", "@authtempo/client"]], ignore: [] }),
  );
  r.write("packages/core/package.json", JSON.stringify({ name: "@authtempo/core", version }));
  r.write("packages/client/package.json", JSON.stringify({ name: "@authtempo/client", version }));
  r.commit("release");
  return r;
}

describe("check-tag", () => {
  it("passes v0.1.0 at group 0.1.0 on main", () => {
    const r = tagAt("v0.1.0", "0.1.0", "main");
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-tag: PASS tags=1 failures=0");
  });

  it("fails a tag that differs from the group version", () => {
    expect(tagAt("v0.1.1", "0.1.0", "main").failures).toEqual([
      "the tag v0.1.1 differs from the group version 0.1.0",
    ]);
  });

  it("fails a tag on a commit that is not on main or on release/<minor>", () => {
    expect(tagAt("v0.1.0", "0.1.0", "neither").failures).toEqual([
      "the tagged commit is on neither main nor release/0.1",
    ]);
  });

  it("passes a patch tag of an older minor on release/0.1", () => {
    expect(tagAt("v0.1.3", "0.1.3", "release").failures).toEqual([]);
    // The first version of a minor comes from main, never from a release branch.
    expect(tagAt("v0.1.0", "0.1.0", "release").failures).toEqual([
      "a tag on release/0.1 is a patch, and v0.1.0 is not",
    ]);
  });

  it("fails a tag v0.0.x", () => {
    // The first release is 0.1.0 (rulings 28 and 30 of the plan 12j lane).
    for (const version of ["0.0.1", "0.0.0"])
      expect(tagAt(`v${version}`, version, "main").failures).toEqual([
        `the tag v${version} is at 0.0.x; the first release is 0.1.0, so no tag is v0.0.x`,
      ]);
    // The rule holds off main too: a patch tag on release/0.0 is still 0.0.x.
    expect(tagAt("v0.0.1", "0.0.1", "release").failures).toEqual([
      "the tag v0.0.1 is at 0.0.x; the first release is 0.1.0, so no tag is v0.0.x",
    ]);
    expect(tagAt("v0.1.0", "0.1.0", "main").failures).toEqual([]);
    expect(tagAt("v1.0.0", "1.0.0", "main").failures).toEqual([]);
  });

  it("fails a tag with a prerelease part", () => {
    expect(tagAt("v0.2.0-rc.1", "0.2.0-rc.1", "main").failures).toEqual([
      "the tag v0.2.0-rc.1 has a prerelease part, and the release has no pre mode",
    ]);
    expect(tagAt("0.1.0", "0.1.0", "main").failures).toEqual([
      "the tag 0.1.0 is not v<major>.<minor>.<patch>",
    ]);
  });

  it("reads the group version and the branches of the checkout", () => {
    repo = released("0.1.0");
    repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(entry(repo.root, "v0.1.0")).toEqual({
      lines: ["check-tag: PASS tags=1 failures=0"],
      code: 0,
    });
    expect(entry(repo.root, "v0.1.1").lines).toEqual([
      "check-tag: FAIL tags=1 failures=1",
      "  the tag v0.1.1 differs from the group version 0.1.0",
    ]);
    // A commit after main is on no branch of the remote.
    repo.write("packages/core/x.txt", "x\n");
    repo.commit("not on main");
    expect(entry(repo.root, "v0.1.0")).toEqual({
      lines: [
        "check-tag: FAIL tags=1 failures=1",
        "  the tagged commit is on neither main nor release/0.1",
      ],
      code: 1,
    });
    repo.git(["update-ref", "refs/remotes/origin/release/0.1", "HEAD"]);
    expect(entry(repo.root, "v0.1.0").lines).toEqual([
      "check-tag: FAIL tags=1 failures=1",
      "  a tag on release/0.1 is a patch, and v0.1.0 is not",
    ]);
  });

  it("fails a tag on a commit that release/<minor> does not hold", () => {
    // origin/main and origin/release/0.1 hold the first commit. HEAD is a later
    // commit at 0.1.1, so it is on neither branch, though release/0.1 exists.
    repo = released("0.1.0");
    repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repo.git(["update-ref", "refs/remotes/origin/release/0.1", "HEAD"]);
    for (const name of ["core", "client"])
      repo.write(
        `packages/${name}/package.json`,
        JSON.stringify({ name: `@authtempo/${name}`, version: "0.1.1" }),
      );
    repo.commit("0.1.1");
    expect(entry(repo.root, "v0.1.1")).toEqual({
      lines: [
        "check-tag: FAIL tags=1 failures=1",
        "  the tagged commit is on neither main nor release/0.1",
      ],
      code: 1,
    });
    repo.git(["update-ref", "refs/remotes/origin/release/0.1", "HEAD"]);
    expect(entry(repo.root, "v0.1.1")).toEqual({
      lines: ["check-tag: PASS tags=1 failures=0"],
      code: 0,
    });
  });

  it("prints a FAIL line, not a stack, when git exits with an error", () => {
    // origin/main has a parent commit that the object store lacks, so the walk
    // of git merge-base exits 128.
    repo = released("0.1.0");
    const first = repo.git(["rev-parse", "HEAD"]).trim();
    repo.write("packages/core/x.txt", "x\n");
    repo.commit("x");
    const lost = repo.git(["rev-parse", "HEAD"]).trim();
    repo.write("packages/core/y.txt", "y\n");
    repo.commit("y");
    repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repo.git(["checkout", "--quiet", "-b", "side", first]);
    repo.write("packages/core/z.txt", "z\n");
    repo.commit("side");
    rmSync(join(repo.root, ".git/objects", lost.slice(0, 2), lost.slice(2)));
    expect(entry(repo.root, "v0.1.0")).toEqual({
      lines: [
        "check-tag: FAIL tags=0 failures=1",
        "  git merge-base --is-ancestor HEAD refs/remotes/origin/main exited 128",
      ],
      code: 1,
    });
  });

  it("fails a checkout with no origin/main or with two versions in the group", () => {
    repo = released("0.1.0");
    expect(entry(repo.root, "v0.1.0")).toEqual({
      lines: [
        "check-tag: FAIL tags=0 failures=1",
        "  the checkout has no refs/remotes/origin/main; fetch the full history (fetch-depth: 0)",
      ],
      code: 1,
    });
    repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repo.write(
      "packages/client/package.json",
      JSON.stringify({ name: "@authtempo/client", version: "0.1.1" }),
    );
    expect(entry(repo.root, "v0.1.0").lines).toEqual([
      "check-tag: FAIL tags=0 failures=1",
      "  the released packages hold 2 versions: 0.1.0, 0.1.1",
    ]);
  });
});
