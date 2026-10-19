import { execFileSync } from "node:child_process";

/**
 * Each file that git tracks, by its path from `root`, or the error of git
 * ls-files. Pass the repository root. A copy made by git archive has no git,
 * so the caller gets the error and keeps its other checks running.
 */
export function trackedFiles(root: string): { files: Set<string> } | { error: string } {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { files: new Set(out.split("\n").filter((line) => line !== "")) };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const text = (err.stderr || err.message || String(e)).trim().split("\n")[0] ?? "";
    return { error: `git ls-files failed: ${text}` };
  }
}
