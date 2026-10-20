import { execFileSync } from "node:child_process";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The commit where the checkout left `ref`. */
export function mergeBase(root: string, ref: string): string {
  return git(root, ["merge-base", "HEAD", ref]).trim();
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
 * counts too.
 */
export function changedFiles(root: string, base: string): string[] {
  const changed = git(root, ["diff", "--name-only", "-z", base]).split("\0");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  return [...new Set([...changed, ...untracked].filter((p) => p !== ""))].sort();
}
