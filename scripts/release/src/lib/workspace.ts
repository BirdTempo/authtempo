import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The keys of a workspace package.json that the release checks read. */
export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  files?: string[];
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  name: string;
  /** The package folder, relative to the repository root, with "/" as the separator. */
  dir: string;
  manifest: Manifest;
}

/**
 * The globs of pnpm-workspace.yaml: each line under `packages:` that starts
 * with "- ". A glob ends in "/*" or names one folder. Any other form throws,
 * so a new glob form cannot silently match nothing.
 */
export function readGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // A line with no indent starts the next key.
    if (/^\S/.test(raw)) break;
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const glob = line
      .slice(2)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!/^[\w.-]+(\/[\w.-]+)*(\/\*)?$/.test(glob))
      throw new Error(`pnpm-workspace.yaml: the glob ${glob} is not "<folder>/*" or "<folder>"`);
    globs.push(glob);
  }
  return globs;
}

/** Each workspace package that the globs of `root`/pnpm-workspace.yaml match, by folder. */
export function readWorkspace(root: string): WorkspacePackage[] {
  const globs = readGlobs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      if (!existsSync(join(root, parent))) continue;
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true }))
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
    } else dirs.push(glob);
  }
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs.sort()) {
    const path = join(root, dir, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    packages.push({ name: manifest.name, dir, manifest });
  }
  return packages;
}
