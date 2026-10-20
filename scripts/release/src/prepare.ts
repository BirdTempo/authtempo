import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { breakingByMinor, CORE, readDeprecations } from "./check-pack.ts";
import { CHANGELOG_FILE, repositoryFor } from "./lib/pack-rules.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, requireCounts, unreadReport } from "./lib/report.ts";
import { type Manifest, readWorkspace } from "./lib/workspace.ts";

/**
 * The file that the dry run writes at the root of each release copy. prepare
 * refuses a folder without it, so it never removes the hold on main.
 */
export const RELEASE_COPY_MARKER = ".release-copy";

export interface PrepareOptions {
  /** The package folder, relative to the root, such as packages/client. */
  dir: string;
  /** The license of the root package.json. */
  license: string;
  /** The url of release/repository.json. */
  repository: string;
  /** core only: the Breaking: lines of each minor of its CHANGELOG.md. */
  breaking?: Record<string, string[]>;
  /** core only: release/deprecations.json. */
  deprecations?: unknown[];
}

/**
 * The released manifest of one package (spec 33 item 4.2): no private, and
 * the release fields from their one source each. The key order stays, and
 * license, repository, and publishConfig follow version.
 */
export function prepareManifest(manifest: Manifest, options: PrepareOptions): Manifest {
  // spec 33 item 1: each released package names its Node floor.
  if (typeof manifest.engines?.node !== "string")
    throw new Error(`${manifest.name}: the manifest has no engines`);
  const fields: Record<string, unknown> = {
    license: options.license,
    repository: repositoryFor(options.repository, options.dir),
    publishConfig: { access: "public", provenance: true },
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "private") continue;
    if (key in fields) continue;
    out[key] = value;
    if (key === "version") Object.assign(out, fields);
  }
  // upgrade reads the two facts from the registry document of core (spec 33 item 10.5).
  if (options.breaking !== undefined || options.deprecations !== undefined) {
    const facts =
      manifest.authtempo !== null && typeof manifest.authtempo === "object"
        ? { ...(manifest.authtempo as Record<string, unknown>) }
        : {};
    if (options.breaking !== undefined) facts.breaking = options.breaking;
    if (options.deprecations !== undefined) facts.deprecations = options.deprecations;
    out.authtempo = facts;
  }
  return out as Manifest;
}

/**
 * Prepares each released package of the release copy at `root`. It writes
 * prepareManifest back with the indent of the file. It copies the root LICENSE
 * into the package folder. It throws in a folder with .git or with no marker,
 * such as the checkout.
 */
export function prepare(root: string): Report {
  if (!existsSync(join(root, RELEASE_COPY_MARKER)) || existsSync(join(root, ".git")))
    throw new Error(
      `prepare runs only in a release copy: ${root} has .git or no ${RELEASE_COPY_MARKER} file`,
    );
  const failures: string[] = [];
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
  const license = rootManifest.license;
  if (typeof license !== "string") failures.push("the root package.json has no license");
  const { url } = JSON.parse(readFileSync(join(root, "release/repository.json"), "utf8")) as {
    url: string;
  };
  const deprecations = readDeprecations(root);
  const folders = new Map(readWorkspace(root).map((p) => [p.name, p]));

  let packages = 0;
  for (const name of releasedNames(root)) {
    const p = folders.get(name);
    if (p === undefined) {
      failures.push(`${name}: no workspace folder`);
      continue;
    }
    packages++;
    if (typeof license !== "string") continue;
    const file = join(root, p.dir, "package.json");
    const text = readFileSync(file, "utf8");
    const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
    let facts = {};
    if (name === CORE) {
      const changelog = join(root, p.dir, CHANGELOG_FILE);
      const lines = existsSync(changelog) ? readFileSync(changelog, "utf8") : "";
      facts = { breaking: breakingByMinor(lines), deprecations };
    }
    let manifest: Manifest;
    try {
      manifest = prepareManifest(p.manifest, { dir: p.dir, license, repository: url, ...facts });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    writeFileSync(
      file,
      `${JSON.stringify(manifest, null, indent)}${text.endsWith("\n") ? "\n" : ""}`,
    );
    copyFileSync(join(root, "LICENSE"), join(root, p.dir, "LICENSE"));
  }
  return requireCounts({ name: "prepare", counts: { packages }, failures, notes: [] }, [
    "packages",
  ]);
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  let report: Report;
  try {
    report = prepare(root);
  } catch (error) {
    report = unreadReport(
      "prepare",
      ["packages"],
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const line of reportLines(report)) console.log(line);
  if (report.failures.length > 0) process.exit(1);
}
