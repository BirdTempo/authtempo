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
 * The root that astro.config.mjs found from its own file, which is never a
 * chunk. The Astro build writes it in place of this name (vite.define). Under
 * vitest and check.ts no define runs, and the name has no value.
 */
declare const __AUTHTEMPO_REPO_ROOT__: string | undefined;

/**
 * The repository root, with no trailing slash (ruling 24 of the plan 11b lane).
 * In the Astro build it is the root of the config. A build started in another
 * folder writes its chunks under that folder, so a walk from a chunk can reach
 * that folder's root. Elsewhere the walk starts at this module's own file,
 * never at the working folder.
 */
export const REPO_ROOT =
  typeof __AUTHTEMPO_REPO_ROOT__ === "string"
    ? __AUTHTEMPO_REPO_ROOT__
    : findRoot(dirname(fileURLToPath(import.meta.url)));

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

/**
 * The URL of the repository from release/repository.json, the one source of
 * plan 12j (ruling 34: https://github.com/BirdTempo/authtempo). The changelog
 * component links each package file through it. It throws when the file or
 * its url is missing, so a page fails closed and links no other repository.
 */
export function repositoryUrl(): string {
  const text = readRepoText("release/repository.json");
  if (text === null) throw new Error("repo.ts: release/repository.json is missing");
  const { url } = JSON.parse(text) as { url?: unknown };
  if (typeof url !== "string" || !url.startsWith("https://github.com/"))
    throw new Error("repo.ts: release/repository.json has no https://github.com/ url");
  return url;
}
