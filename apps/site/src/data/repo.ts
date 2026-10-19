import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The nearest folder at or above `from` that holds pnpm-workspace.yaml. It
 * throws when no folder up to the file system root holds one. A page and a
 * check then fail closed, and claim no license or channel (ruling 23 of the
 * plan 11b lane).
 */
export function findRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`repo.ts: no pnpm-workspace.yaml at or above ${from}`);
    dir = up;
  }
}

/**
 * The repository root, with no trailing slash. The walk starts at this
 * module's own file, never at the working folder, so a run started in another
 * checkout still reads this checkout. Under vitest and check.ts the file is
 * src/data/repo.ts. In the Astro build, Vite bundles it into a chunk under
 * apps/site/dist/.prerender/, and the walk from there reaches the same root.
 */
export const REPO_ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));

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
  return licenseOf(text);
}

/** The license field of a package.json text: a string that is not blank, else null. */
export function licenseOf(packageJson: string): string | null {
  const pkg = JSON.parse(packageJson) as { license?: unknown };
  return typeof pkg.license === "string" && pkg.license.trim() !== "" ? pkg.license : null;
}
