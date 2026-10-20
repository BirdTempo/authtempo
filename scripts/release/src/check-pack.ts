import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  ALWAYS_SHIPPED,
  BINARY_EXTENSIONS,
  CHANGELOG_FILE,
  DECLARED_BINARIES,
  forbiddenMatch,
  RELEASE_LICENSE,
  repositoryFor,
} from "./lib/pack-rules.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, requireCounts, summaryLine } from "./lib/report.ts";
import { type Manifest, readWorkspace } from "./lib/workspace.ts";

/** One release tarball and the sources that check-pack holds it to. */
export interface PackInput {
  /** Each file path in the tarball, under package/, with the prefix removed. */
  files: string[];
  /** The packed package.json. */
  manifest: Manifest;
  /** The packed LICENSE text, or null when the tarball has none. */
  license: string | null;
  /** The entry of the package in release/pack-needs.json. */
  needs: string[];
  groupVersion: string;
  /** The root LICENSE text, which prepare copies into each package folder. */
  rootLicense: string;
  /** The expected repository url and folder of the package. */
  repository: { url: string; directory: string };
  /** The Breaking: lines of each minor of core's packed CHANGELOG.md. Read for core only. */
  breaking: Record<string, string[]>;
  /** release/deprecations.json. Read for core only. */
  deprecations: unknown[];
}

/** The version of every package on main. No release carries it (spec 33 item 11). */
const UNPUBLISHED_VERSION = "0.0.0";

/** The package whose manifest carries the upgrade facts (spec 33 item 10.5). */
const CORE = "@authtempo/core";

const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Each file path that a field names, with the field as a label, such as `exports["./errors"].default`. */
function targets(label: string, value: unknown): [label: string, path: string][] {
  if (typeof value === "string") return [[label, value.replace(/^\.\//, "")]];
  if (Array.isArray(value)) return value.flatMap((v, i) => targets(`${label}[${i}]`, v));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) =>
      targets(k.startsWith(".") || label === "bin" ? `${label}["${k}"]` : `${label}.${k}`, v),
    );
  return [];
}

/**
 * The rules of spec 33 item 6 for one tarball. Each failure names the file or
 * the field. The entry adds the package name.
 */
export function checkPack(input: PackInput): Report {
  const { files, manifest } = input;
  const failures: string[] = [];
  const present = new Set(files);
  const entries = (manifest.files ?? []).map((e) => e.replace(/^\.\//, "").replace(/\/$/, ""));

  // A glob or a negation in files needs a matcher that this check does not have.
  for (const entry of entries)
    if (/[*?![\]{}]/.test(entry))
      failures.push(`the files entry ${entry} is a pattern, and check-pack reads only paths`);
  const inFiles = (p: string) => entries.some((e) => p === e || p.startsWith(`${e}/`));
  const always: readonly string[] = ALWAYS_SHIPPED;
  const binaries = DECLARED_BINARIES[manifest.name] ?? [];

  for (const p of files) {
    const forbidden = forbiddenMatch(p, entries);
    if (forbidden !== null) failures.push(`the tarball holds ${p}, which matches ${forbidden}`);
    else if (!always.includes(p) && !inFiles(p))
      failures.push(`the tarball holds ${p}, which is outside files and the always-shipped files`);
    if (BINARY_EXTENSIONS.some((ext) => p.endsWith(ext)) && !binaries.includes(p))
      failures.push(`the tarball holds the binary file ${p}, and no declared binary list names it`);
  }

  for (const [label, path] of [
    ...targets("main", manifest.main),
    ...targets("types", manifest.types),
    ...targets("bin", manifest.bin),
    ...targets("exports", manifest.exports),
  ]) {
    if (path.includes("*"))
      failures.push(`${label} names the pattern ${path}, which check-pack cannot read`);
    else if (!present.has(path)) failures.push(`${label} names ${path}, which the tarball lacks`);
  }

  for (const key of DEPENDENCY_KEYS)
    for (const [dep, range] of Object.entries(manifest[key] ?? {}))
      if (range.startsWith("workspace:"))
        failures.push(`${key} holds ${dep} as ${range}, which npm cannot resolve`);

  if ("private" in manifest) failures.push("the manifest holds private");
  // The scaffold reads 0.0.0 as unpublished, so a CLI at 0.0.0 on npm tells
  // each app to run a clone. This is ruling 13 of the plan 12j lane.
  if (manifest.version === UNPUBLISHED_VERSION)
    failures.push(`the version is ${UNPUBLISHED_VERSION}, which the scaffold reads as unpublished`);
  if (manifest.version !== input.groupVersion)
    failures.push(
      `the version is ${manifest.version}, not the group version ${input.groupVersion}`,
    );

  if (manifest.license === undefined) failures.push("the manifest has no license");
  else if (manifest.license !== RELEASE_LICENSE)
    failures.push(`the license is ${manifest.license}, not ${RELEASE_LICENSE}`);

  const repository = (manifest.repository ?? {}) as { url?: unknown; directory?: unknown };
  for (const key of ["url", "directory"] as const) {
    const value = repository[key];
    if (value === undefined) failures.push(`the manifest has no repository.${key}`);
    else if (value !== input.repository[key])
      failures.push(`repository.${key} is ${String(value)}, not ${input.repository[key]}`);
  }

  const publish = (manifest.publishConfig ?? {}) as { access?: unknown; provenance?: unknown };
  if (publish.access !== "public") failures.push("publishConfig.access is not public");
  if (publish.provenance !== true) failures.push("publishConfig.provenance is not true");

  if (!present.has(CHANGELOG_FILE)) failures.push(`the tarball has no ${CHANGELOG_FILE}`);

  if (input.license === null) failures.push("the tarball has no LICENSE");
  else if (input.license !== input.rootLicense)
    failures.push("the LICENSE bytes differ from the root LICENSE");

  // A need that ends in "/" is a folder: at least one file under it ships.
  for (const need of input.needs) {
    if (need.endsWith("/")) {
      if (!files.some((p) => p.startsWith(need)))
        failures.push(
          `the needed folder ${need} of release/pack-needs.json has no file in the tarball`,
        );
    } else if (!present.has(need))
      failures.push(`the needed file ${need} of release/pack-needs.json is not in the tarball`);
  }

  // prepare writes both fields into core only, and upgrade reads them there.
  const facts = (manifest.authtempo ?? {}) as { breaking?: unknown; deprecations?: unknown };
  if (manifest.name === CORE) {
    if (!isDeepStrictEqual(facts.breaking, input.breaking))
      failures.push(`authtempo.breaking differs from the Breaking: lines of ${CHANGELOG_FILE}`);
    if (!isDeepStrictEqual(facts.deprecations, input.deprecations))
      failures.push("authtempo.deprecations differs from release/deprecations.json");
  } else
    for (const key of ["breaking", "deprecations"] as const)
      if (key in facts)
        failures.push(`authtempo.${key} is in ${manifest.name}; only ${CORE} holds it`);

  return requireCounts(
    { name: "check-pack", counts: { tarballs: 1, files: files.length }, failures, notes: [] },
    ["files"],
  );
}

/**
 * The "Breaking:" lines of each minor of a Changesets changelog, by "<major>.<minor>".
 * A minor with no such line has no key. Changesets writes each change as
 * "- <text>", or "- <commit>: <text>" when it reads the git history.
 */
export function breakingByMinor(changelog: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let minor: string | null = null;
  for (const line of changelog.split("\n")) {
    const heading = /^## (\d+)\.(\d+)\.\d+\s*$/.exec(line);
    if (heading) {
      minor = `${heading[1]}.${heading[2]}`;
      continue;
    }
    const entry = /^- (?:[0-9a-f]{7,40}: )?(Breaking: .*\S)\s*$/.exec(line);
    if (minor !== null && entry?.[1] !== undefined) out[minor] = [...(out[minor] ?? []), entry[1]];
  }
  return out;
}

export interface Tarball {
  /** Each file path under package/, with the prefix removed, sorted. */
  files: string[];
  manifest: Manifest;
  license: string | null;
  changelog: string | null;
}

/**
 * Reads a pnpm or npm tarball through the system tar. It refuses an entry
 * that is not a regular file or a folder, such as a link, and a path with a
 * ".." part. pnpm pack writes neither, so a foreign tarball is the reach.
 */
export function readTarball(path: string): Tarball {
  const tar = (args: string[]) =>
    execFileSync("tar", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const lines = (args: string[]) => tar(args).split("\n").slice(0, -1);
  const names = lines(["-tzf", path]);
  // The first character of each long line is the entry type, in bsdtar and in GNU tar.
  const types = lines(["-tvzf", path]).map((l) => l.charAt(0));
  if (types.length !== names.length)
    throw new Error(`${path}: tar lists ${names.length} names and ${types.length} entries`);
  const files = names
    .filter((e, i) => {
      if (e.split("/").includes("..")) throw new Error(`${path}: ${e} has a .. part`);
      if (types[i] === "d") return false;
      if (types[i] !== "-") throw new Error(`${path}: ${e} is not a regular file`);
      return true;
    })
    .map((e) => {
      if (!e.startsWith("package/")) throw new Error(`${path}: ${e} is not under package/`);
      return e.slice("package/".length);
    })
    .sort();
  const read = (file: string) =>
    files.includes(file) ? tar(["-xzOf", path, `package/${file}`]) : null;
  const manifest = read("package.json");
  if (manifest === null) throw new Error(`${path}: the tarball has no package.json`);
  return {
    files,
    manifest: JSON.parse(manifest) as Manifest,
    license: read("LICENSE"),
    changelog: read(CHANGELOG_FILE),
  };
}

/**
 * Checks each tarball against the tree at `root`: the released list, the
 * package folder, release/pack-needs.json, release/repository.json, the root
 * LICENSE, and release/deprecations.json.
 */
export function checkTarballs(root: string, paths: string[]): Report {
  const released = new Set(releasedNames(root));
  const packages = readWorkspace(root).filter((p) => released.has(p.name));
  const dirs = new Map(packages.map((p) => [p.name, p.dir]));
  const versions = [...new Set(packages.map((p) => p.manifest.version))];
  const needs = JSON.parse(readFileSync(join(root, "release/pack-needs.json"), "utf8")) as Record<
    string,
    string[]
  >;
  const { url } = JSON.parse(readFileSync(join(root, "release/repository.json"), "utf8")) as {
    url: string;
  };
  const rootLicense = readFileSync(join(root, "LICENSE"), "utf8");
  // Task 9 of plan 12j writes the register. Until then no item is deprecated.
  const register = join(root, "release/deprecations.json");
  const deprecations = existsSync(register)
    ? (JSON.parse(readFileSync(register, "utf8")) as unknown[])
    : [];

  const failures: string[] = [];
  if (versions.length !== 1)
    failures.push(`the released packages hold ${versions.length} versions: ${versions.join(", ")}`);
  const seen = new Set<string>();
  let files = 0;
  for (const path of paths) {
    let t: Tarball;
    try {
      t = readTarball(path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const name = t.manifest.name;
    const dir = dirs.get(name);
    if (dir === undefined) {
      failures.push(`${path}: ${name} is not a released package`);
      continue;
    }
    if (seen.has(name)) failures.push(`${path}: a second tarball of ${name}`);
    seen.add(name);
    const need = needs[name];
    if (need === undefined) failures.push(`${name}: no entry in release/pack-needs.json`);
    const r = checkPack({
      files: t.files,
      manifest: t.manifest,
      license: t.license,
      needs: need ?? [],
      groupVersion: versions[0] ?? "",
      rootLicense,
      repository: repositoryFor(url, dir),
      breaking: breakingByMinor(t.changelog ?? ""),
      deprecations,
    });
    files += t.files.length;
    for (const f of r.failures) failures.push(`${name}@${t.manifest.version}: ${f}`);
  }
  // A dry run that packs 23 of 24 packages must fail here, not on npm.
  for (const name of released) if (!seen.has(name)) failures.push(`${name}: no tarball`);
  return requireCounts(
    { name: "check-pack", counts: { tarballs: seen.size, files }, failures, notes: [] },
    ["tarballs", "files"],
  );
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = checkTarballs(root, process.argv.slice(2));
  console.log(summaryLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  if (report.failures.length > 0) process.exit(1);
}
