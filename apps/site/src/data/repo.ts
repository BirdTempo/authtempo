import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The repository root: the nearest folder at or above the working folder
 * that holds pnpm-workspace.yaml. It is not read from import.meta.url,
 * because Vite bundles this file for a page, and the URL then names a build
 * chunk. The site build, vitest, and check.ts each run inside the repository.
 */
function findRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`repo.ts: no pnpm-workspace.yaml at or above ${from}`);
    dir = up;
  }
}

/** The repository root, with no trailing slash. */
export const REPO_ROOT = findRoot(process.cwd());

/**
 * A repository file's text by its path from the root, or null when it does
 * not exist. The root pages (plan 11b Task 5) and their tests read
 * package.json and SECURITY.md through it, so both read the same file.
 */
export function readRepoText(path: string): string | null {
  const abs = join(REPO_ROOT, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/**
 * The license field of the root package.json, or null while it is not set.
 * Plan 12j sets it. The footer and /pricing/ read this one source (spec 24 item 3).
 */
export function rootLicense(): string | null {
  const text = readRepoText("package.json");
  if (text === null) throw new Error("repo.ts: the root package.json is missing");
  const pkg = JSON.parse(text) as { license?: unknown };
  return typeof pkg.license === "string" && pkg.license.trim() !== "" ? pkg.license : null;
}
