import { existsSync } from "node:fs";
import { join } from "node:path";
import { GIT_TIMEOUT_MS, RunTimeout, runSync } from "./run-sync.ts";

// The error of a failed call holds the stderr of git, so the entry prints only its own lines.
function git(root: string, args: string[]): string {
  const r = runSync("git", args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0)
    throw new Error(
      `git ${args.join(" ")} exited ${r.status ?? "with no code"}: ${r.stderr.trim()}`,
    );
  return r.stdout;
}

/**
 * No merge base of HEAD and the ref. A shallow clone, a ref that the checkout
 * lacks, and an unrelated history each give it.
 */
export class NoMergeBase extends Error {}

/** The commit where the checkout left `ref`. */
export function mergeBase(root: string, ref: string): string {
  try {
    return git(root, ["merge-base", "HEAD", ref]).trim();
  } catch (error) {
    // A call past its limit is not an answer of git, so its own error goes up.
    if (error instanceof RunTimeout) throw error;
    throw new NoMergeBase(
      `no merge base of HEAD and ${ref}; fetch the full history (fetch-depth: 0)`,
    );
  }
}

/** The text of `path` at `ref`, or null when the file does not exist there. */
export function showAt(root: string, ref: string, path: string): string | null {
  const listed = git(root, ["ls-tree", "--name-only", ref, "--", path]).trim();
  if (listed === "") return null;
  return git(root, ["show", `${ref}:${path}`]);
}

/**
 * Each path that differs between `base` and the working tree, with each
 * untracked file that git does not ignore. A change that is not committed yet
 * counts too. A move lists the old path and the new path. With the rename
 * detection of git, a move out of a released package lists only the new path.
 */
export function changedFiles(root: string, base: string): string[] {
  const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", base]).split("\0");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  return [...new Set([...changed, ...untracked].filter((p) => p !== ""))].sort();
}

/** The commit of HEAD. */
export function headCommit(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

/** The commit of `ref`, or null when the checkout lacks it. */
export function commitOf(root: string, ref: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch (error) {
    if (error instanceof RunTimeout) throw error;
    return null;
  }
}

/** True when the commit `ref` is HEAD or an ancestor of HEAD. */
export function isAncestor(root: string, ref: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", ref, "HEAD"]);
    return true;
  } catch (error) {
    if (error instanceof RunTimeout) throw error;
    return false;
  }
}

/**
 * The newest release tag `<prefix><major>.<minor>.<patch>` that HEAD holds,
 * in the version order, or null. A tag of the commit of HEAD is not before
 * HEAD, so it never counts.
 */
export function lastReleaseTag(root: string, prefix: string): string | null {
  const own = new Set(git(root, ["tag", "--points-at", "HEAD"]).split("\n"));
  const form = new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+$`);
  return (
    git(root, ["tag", "--merged", "HEAD", "--sort=-v:refname"])
      .split("\n")
      .find((t) => form.test(t) && !own.has(t)) ?? null
  );
}

/** The count of commits on HEAD since `base`. */
export function commitCount(root: string, base: string): number {
  return Number(git(root, ["rev-list", "--count", `${base}..HEAD`]).trim());
}

/** Each file path in the tree of `ref`, sorted. */
export function filesAt(root: string, ref: string): string[] {
  return git(root, ["ls-tree", "-r", "--name-only", "-z", ref])
    .split("\0")
    .filter((p) => p !== "")
    .sort();
}

/**
 * Each file in the working tree that git tracks or does not ignore, sorted. The
 * index still lists a tracked file that is deleted and not staged, so each path
 * must exist on disk.
 */
export function worktreeFiles(root: string): string[] {
  return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((p) => p !== "" && existsSync(join(root, p)))
    .sort();
}
