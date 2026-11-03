import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  commitCount,
  commitOf,
  filesAt,
  isAncestor,
  mergeBase,
  showAt,
  worktreeFiles,
} from "../src/lib/git.ts";
import { RunTimeout } from "../src/lib/run-sync.ts";
import { makeRepo, type Repo } from "./support/git-repo.ts";
import { STALL_MS, withStalledGit } from "./support/stall.ts";

let repo: Repo | undefined;
afterEach(() => repo?.remove());

/** A repository with two commits on main and one on the branch "work". */
function branched(): { repo: Repo; base: string } {
  const r = makeRepo();
  r.write("a.txt", "a1\n");
  r.write(".gitignore", "ignored.txt\n");
  r.commit("first");
  r.write("b.txt", "b1\n");
  r.commit("second");
  const base = r.git(["rev-parse", "HEAD"]).trim();
  r.git(["checkout", "--quiet", "-b", "work"]);
  r.write("a.txt", "a2\n");
  r.commit("third");
  r.git(["checkout", "--quiet", "main"]);
  r.write("c.txt", "c1\n");
  r.commit("on main after the branch");
  r.git(["checkout", "--quiet", "work"]);
  return { repo: r, base };
}

describe("git", () => {
  it("finds the merge base and counts the commits since it", () => {
    const b = branched();
    repo = b.repo;
    expect(mergeBase(repo.root, "main")).toBe(b.base);
    expect(commitCount(repo.root, b.base)).toBe(1);
    expect(commitCount(repo.root, "HEAD")).toBe(0);
  });

  it("reads a file at a commit, and null for a file that is not there", () => {
    const b = branched();
    repo = b.repo;
    expect(showAt(repo.root, b.base, "a.txt")).toBe("a1\n");
    expect(showAt(repo.root, b.base, "c.txt")).toBeNull();
    expect(filesAt(repo.root, b.base)).toEqual([".gitignore", "a.txt", "b.txt"]);
  });

  it("lists a committed, an uncommitted, and an untracked change, and no ignored file", () => {
    const b = branched();
    repo = b.repo;
    repo.write("b.txt", "b2\n");
    repo.write("new.txt", "n\n");
    repo.write("ignored.txt", "i\n");
    expect(changedFiles(repo.root, b.base)).toEqual(["a.txt", "b.txt", "new.txt"]);
  });

  it("lists the old path and the new path of a move", () => {
    const b = branched();
    repo = b.repo;
    repo.write("src/foo.ts", "export const foo = 1;\n");
    repo.commit("add foo");
    const before = repo.git(["rev-parse", "HEAD"]).trim();
    mkdirSync(join(repo.root, "test"));
    repo.git(["mv", "src/foo.ts", "test/foo.ts"]);
    repo.commit("move foo");
    // With rename detection, git lists only test/foo.ts.
    expect(changedFiles(repo.root, before)).toEqual(["src/foo.ts", "test/foo.ts"]);
  });

  it("lists the working tree files without a removed file or an ignored file", () => {
    const b = branched();
    repo = b.repo;
    // The index still holds a.txt, so only the file test drops it.
    rmSync(join(repo.root, "a.txt"));
    repo.write("new.txt", "n\n");
    repo.write("ignored.txt", "i\n");
    expect(worktreeFiles(repo.root)).toEqual([".gitignore", "b.txt", "new.txt"]);
  });
});

// Each catch of git.ts lets a call past its limit through. Without it, a hung
// git reads as no merge base, as no commit, or as no ancestor (review of Task 1
// of plan 12n, L1).
describe("git calls past their limit", () => {
  /** The error that `fn` throws with a stalled git, or its answer when it throws none. */
  function stalled(fn: (root: string) => unknown): unknown {
    const b = branched();
    repo = b.repo;
    const root = b.repo.root;
    return withStalledGit(() => {
      try {
        return fn(root);
      } catch (error) {
        return error;
      }
    });
  }

  it("lets the RunTimeout of mergeBase through", () => {
    const error = stalled((root) => mergeBase(root, "main"));
    expect(error).toBeInstanceOf(RunTimeout);
    expect((error as Error).message).toBe(`git merge-base HEAD main did not end in ${STALL_MS} ms`);
  });

  it("lets the RunTimeout of commitOf through", () => {
    const error = stalled((root) => commitOf(root, "main"));
    expect(error).toBeInstanceOf(RunTimeout);
    expect((error as Error).message).toBe(
      `git rev-parse --verify --quiet main^{commit} did not end in ${STALL_MS} ms`,
    );
  });

  it("lets the RunTimeout of isAncestor through", () => {
    const error = stalled((root) => isAncestor(root, "main"));
    expect(error).toBeInstanceOf(RunTimeout);
    expect((error as Error).message).toBe(
      `git merge-base --is-ancestor main HEAD did not end in ${STALL_MS} ms`,
    );
  });
});
