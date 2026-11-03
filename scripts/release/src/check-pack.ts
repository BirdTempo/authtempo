import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type Deprecation, readDeprecations } from "./lib/deprecations.ts";
import {
  ALWAYS_SHIPPED,
  BINARY_EXTENSIONS,
  CHANGELOG_FILE,
  DECLARED_BINARIES,
  forbiddenMatch,
  INSTALL_SCRIPTS,
  PACK_SCRIPTS,
  RELEASE_LICENSE,
  repositoryFor,
  VERSION_CONSTANTS,
} from "./lib/pack-rules.ts";
import { FIRST_RELEASE } from "./lib/release-facts.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, requireCounts, unreadReport } from "./lib/report.ts";
import {
  noteForms,
  UNPUBLISHED_LISTS,
  // The version of every package on main. No release carries it (spec 33 item 11).
  UNPUBLISHED_VERSION,
  type UnpublishedLists,
  unpublishedFailures,
} from "./lib/unpublished.ts";
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
  deprecations: Deprecation[];
  /** The scripts of the workspace manifest. pnpm 12.8.1 pack strips the publish scripts from the packed one. */
  scripts: Record<string, unknown>;
  /**
   * The packed text of the file of VERSION_CONSTANTS for the package, or null
   * when the tarball lacks it. A package with no entry there leaves it out.
   */
  versionText?: string | null;
}

/** The package whose manifest carries the upgrade facts (spec 33 item 10.5). prepare writes them. */
export const CORE = "@authtempo/core";

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
  const packed = (manifest.scripts ?? {}) as Record<string, unknown>;
  for (const script of PACK_SCRIPTS)
    if (script in packed || script in input.scripts)
      failures.push(`scripts.${script} runs at pack or publish`);
  for (const script of INSTALL_SCRIPTS)
    if (script in packed || script in input.scripts)
      failures.push(
        `scripts.${script} runs at each install of an app; a released package runs no install script`,
      );
  // The scaffold reads 0.0.0 as unpublished, so a CLI at 0.0.0 on npm tells
  // each app to run a clone. This is ruling 13 of the plan 12j lane.
  if (manifest.version === UNPUBLISHED_VERSION)
    failures.push(`the version is ${UNPUBLISHED_VERSION}, which the scaffold reads as unpublished`);
  // A patch at 0.0.0 gives 0.0.1, and the first release is FIRST_RELEASE (ruling 28 of the plan 12j lane).
  if (/^0\.0\.\d+$/.test(manifest.version) && manifest.version !== UNPUBLISHED_VERSION)
    failures.push(
      `the version is ${manifest.version}; the first release is ${FIRST_RELEASE}, so no release is at 0.0.x`,
    );
  if (manifest.version !== input.groupVersion)
    failures.push(
      `the version is ${manifest.version}, not the group version ${input.groupVersion}`,
    );
  // changeset version moves only package.json, so a literal in dist stayed at
  // 0.0.0 in the tarballs of 0.1.0 (ruling 65 of plan 12j, M2).
  const constant = VERSION_CONSTANTS[manifest.name];
  if (constant !== undefined) {
    const text = input.versionText ?? null;
    const form = new RegExp(`^export const ${constant.name} = "([^"\\n]*)";$`, "gm");
    const values = text === null ? [] : [...text.matchAll(form)].map((m) => m[1] ?? "");
    if (text === null)
      failures.push(
        `the tarball lacks ${constant.file}, which holds ${constant.name}, the version that the code answers`,
      );
    else if (values.length !== 1)
      failures.push(`${constant.file} holds ${values.length} values of ${constant.name}, not 1`);
    else if (values[0] !== manifest.version)
      failures.push(
        `${constant.file} gives ${constant.name} ${values[0]}, not the manifest version ${manifest.version}`,
      );
  }

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
 * The marker of a break in a changeset body: a line that starts with this
 * text. check-changesets refuses each other form, and breakingByMinor reads
 * this form in the changelog. So each "Breaking:" line of a changeset either
 * reaches upgrade or fails the check (ruling 77 of plan 12j).
 */
export const BREAKING = "Breaking: ";

/** The text of a break line, with some text after the marker. Both checks read this one pattern. */
const BREAKING_TEXT = `${BREAKING}.*\\S`;

/** True when a line of a changeset body is a break line in the form that breakingByMinor reads. */
export function isBreaking(line: string): boolean {
  return new RegExp(`^${BREAKING_TEXT}`).test(line);
}

/**
 * True when a line of a changeset body names a break in a form that
 * breakingByMinor does not read: "Breaking:" after a space, a list marker,
 * or a quote marker, in another case, or with no text after it. Changesets
 * indents a later line and keeps its marker, so `changeset version` wrote
 * "  - Breaking: ..." for a list item, and no reader found it (ruling 77 of
 * plan 12j, item 3; test/fixtures/changelogs/core-breaking-forms-3.0.3.md).
 */
export function unreadBreaking(line: string): boolean {
  return !isBreaking(line) && /^(?:[\s>*+-]|\d+[.)])*breaking:/i.test(line);
}

/** A changelog line of a change that holds a break line: the first line or a later line. */
const BREAKING_ENTRY = new RegExp(`^(?:- (?:[0-9a-f]{7,40}: )?| {2})(${BREAKING_TEXT})\\s*$`);

/**
 * The "Breaking:" lines of each minor of a Changesets changelog, by "<major>.<minor>".
 * A minor with no such line has no key. Changesets writes each change as
 * "- <text>", or "- <commit>: <text>" when it reads the git history. It
 * writes each later line of a change with two spaces in front (the default
 * changelog of @changesets/cli 3.0.3, read in a real `changeset version`
 * output on 2026-10-30, test/fixtures/changelogs). So a "Breaking:" line
 * after the first line of a changeset counts too (ruling 67 of plan 12j, Major 3).
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
    const entry = BREAKING_ENTRY.exec(line);
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
  /** The bytes of the tarball, read once. Each read of the check uses them. */
  bytes: Buffer;
  /** The SHA-256 of those bytes, which SHA256SUMS holds. */
  sha256: string;
}

/**
 * The limit of one tar call, in milliseconds. The largest tarball of the
 * group lists in under one second on an 18-core host, and in a few seconds
 * at load 50. The test timeout of vitest cannot end a sync spawn, because
 * the spawn blocks the event loop. So this limit is the one guard against
 * a tar that never ends (follow-up 15 of plan 12l).
 */
export const TAR_TIMEOUT_MS = 60_000;

/**
 * The start of the name of the private folder of one tar read. The pid lets
 * a test count the folders of its own process while other test files read.
 * The release tests run in the forks pool of vitest, so each test file has
 * its own pid (scripts/release/vitest.config.ts).
 */
export const TAR_FOLDER_PREFIX = `authtempo-check-pack-tar-${process.pid}-`;

/**
 * Runs the system tar with `args` and answers its output. This is the one
 * child process call of the file. tar reads no pipe. On 2026-11-01, a sync
 * spawn fed the bytes of a tarball to bsdtar through its input. That spawn
 * hung one full run for 41 hours on macOS. tar was in a read of its input
 * (follow-up 15 of plan 12l). A call that does not end in `timeoutMs`
 * throws an error that names the call. So a stall fails the check in
 * place of a hang of the run. A call that exits with an error throws
 * `tar <args> failed: <reason>`. The reason is the stderr of tar, or the
 * exit status when stderr is empty. tar's reason goes in the thrown
 * message, and nothing goes to the parent's stderr (ruling 8 of plan 12m).
 */
export function tar(args: readonly string[], timeoutMs = TAR_TIMEOUT_MS): string {
  const call = `tar ${args.join(" ")}`;
  try {
    return execFileSync("tar", args, {
      encoding: "utf8",
      // A tar that ignores SIGTERM, the default signal, must not block a run.
      // SIGKILL ends it at the limit, and the private folder goes away either way.
      killSignal: "SIGKILL",
      // The longest output is the -tv listing of the largest tarball, 72 KB for
      // core 0.1.0 (read 2026-11-03). That is far under 256 MiB, the value of plan 12j.
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const { code, status, stderr } = error as Error & {
      code?: unknown;
      status?: unknown;
      stderr?: unknown;
    };
    if (code === "ETIMEDOUT") throw new Error(`${call} did not end in ${timeoutMs} ms`);
    if (typeof status === "number" && status !== 0)
      throw new Error(`${call} failed: ${String(stderr ?? "").trim() || `exit ${status}`}`);
    throw error;
  }
}

/**
 * Runs `use` with the bytes of a tarball in `tarball.tgz` of a new private
 * folder, and removes the folder after it. The file holds the bytes that
 * the SHA-256 of the check names. So tar reads the bytes that the check
 * read. It never reads the path a second time (ruling 67 of plan 12j, Low 4).
 */
export function withTarballFile<T>(bytes: Buffer, use: (file: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), TAR_FOLDER_PREFIX));
  try {
    const file = join(dir, "tarball.tgz");
    writeFileSync(file, bytes);
    return use(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reads a pnpm or npm tarball through the system tar. It refuses an entry
 * that is not a regular file or a folder, such as a link, and a path with a
 * ".." part. pnpm pack writes neither, so a foreign tarball is the reach.
 * It reads the file once, and tar reads those bytes from a private file. So
 * the SHA-256 names the bytes that the check read, not a second read of the
 * path (ruling 67 of plan 12j, Low 4). A tar error starts with the path of
 * the tarball, as each refusal does. The private file is gone after the
 * read (ruling 8 of plan 12m).
 */
export function readTarball(path: string): Tarball {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return withTarballFile(bytes, (file) => {
    /** Runs one tar call, and puts the path of the tarball before its error. */
    const named = (call: () => string): string => {
      try {
        return call();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path}: ${message}`, { cause: error });
      }
    };
    const lines = (args: string[]) =>
      named(() => tar([...args, file]))
        .split("\n")
        .slice(0, -1);
    const names = lines(["-tzf"]);
    // The first character of each long line is the entry type, in bsdtar and in GNU tar.
    const types = lines(["-tvzf"]).map((l) => l.charAt(0));
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
    const read = (entry: string) =>
      files.includes(entry) ? named(() => tar(["-xzOf", file, `package/${entry}`])) : null;
    const manifest = read("package.json");
    if (manifest === null) throw new Error(`${path}: the tarball has no package.json`);
    return {
      files,
      manifest: JSON.parse(manifest) as Manifest,
      license: read("LICENSE"),
      changelog: read(CHANGELOG_FILE),
      bytes,
      sha256,
    };
  });
}

/**
 * The text of each file of the bytes of a tarball, from one extraction.
 * readTarball has refused each link and each path with a ".." part, so the
 * files stay in the folder. A binary file reads as text with no harm: the
 * rules look for words. The extraction lands beside the file, in the
 * private folder.
 */
export function packedTexts(bytes: Buffer, files: readonly string[]): Map<string, string> {
  return withTarballFile(bytes, (file, dir) => {
    tar(["-xzf", file, "-C", dir]);
    return new Map(files.map((f) => [f, readFileSync(join(dir, "package", f), "utf8")]));
  });
}

/**
 * A path of a local machine in a packed text (ruling 50 of plan 12j): a home
 * folder of macOS or Linux at the start of a path, such as /Users/<name>/, or
 * a drive path of Windows, such as C:\. A tarball ships to every app, and such
 * a path names a person and a machine. The SCIM routes of core hold
 * "/scim/v2/Users/:id" and "PATCH /Users/:id", which the form does not match:
 * it needs a path start, a folder name, and a slash. The released tree held
 * no match on 2026-10-30 (1755 packed files with dist). A source map or a
 * stack text names a file as a URL, such as file:///Users/<name>/, which the
 * path form misses (ruling 61 of plan 12j, A), so the URL form is a third form.
 */
export const LOCAL_PATH =
  /(?<![\w/.-])\/(?:Users|home)\/[A-Za-z0-9._-]+\/|file:\/\/\/(?:Users|home)\/[A-Za-z0-9._-]+\/|(?<!\w)[A-Za-z]:\\{1,2}[A-Za-z0-9._-]/;

/** A key that names a registry or a proxy, such as registry, registries, @authtempo:registry, httpsProxy, or https-proxy. */
const REGISTRY_KEY = /registr|proxy/i;

/** The folders that the .npmrc walk skips: the files of the installed packages and of git. */
const WALK_SKIPS = ["node_modules", ".git"];

/** Each path of `value` whose last key names a registry or a proxy. The dependency maps hold package names, so they stay out. */
function registryKeys(value: unknown, path: string[] = []): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, v]) => {
    if (path.length === 0 && (DEPENDENCY_KEYS as readonly string[]).includes(key)) return [];
    const at = [...path, key];
    return [...(REGISTRY_KEY.test(key) ? [at.join(".")] : []), ...registryKeys(v, at)];
  });
}

/** The key of each line of a YAML file, with its line number. A comment and a list item mark stay out. */
function yamlKeys(text: string): { line: number; key: string }[] {
  return text.split("\n").flatMap((raw, i) => {
    const m = /^\s*(?:-\s+)?(?:"([^"]*)"|'([^']*)'|([^\s"'#:][^:#]*?))\s*:(?:\s|$)/.exec(raw);
    const key = m?.[1] ?? m?.[2] ?? m?.[3];
    return key === undefined ? [] : [{ line: i + 1, key }];
  });
}

/**
 * The failures of the config files of the tree at `root` that npm or pnpm reads
 * at a publish: each .npmrc, and each registry or proxy key of the root
 * package.json, pnpm-workspace.yaml, and each released manifest. publish.ts runs
 * npm in the checkout, so such a file can move the publish (ruling 32 of the plan 12j lane).
 */
export function configFailures(root: string, released: readonly { dir: string }[]): string[] {
  const failures: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIPS.includes(entry.name)) walk(path);
      } else if (entry.name === ".npmrc")
        failures.push(
          `${relative(root, path)}: an .npmrc, which can name a registry, a proxy, or a token`,
        );
    }
  };
  walk(root);
  for (const file of ["package.json", ...released.map((p) => join(p.dir, "package.json"))]) {
    if (!existsSync(join(root, file))) continue;
    for (const key of registryKeys(JSON.parse(readFileSync(join(root, file), "utf8"))))
      failures.push(`${file}: the key ${key} names a registry or a proxy`);
  }
  const workspace = join(root, "pnpm-workspace.yaml");
  if (existsSync(workspace))
    for (const { line, key } of yamlKeys(readFileSync(workspace, "utf8")))
      if (REGISTRY_KEY.test(key))
        failures.push(
          `pnpm-workspace.yaml: line ${line}: the key ${key} names a registry or a proxy`,
        );
  return failures;
}

/**
 * Checks each tarball against the tree at `root`: the released list, the
 * package folder, release/pack-needs.json, release/repository.json, the root
 * LICENSE, release/deprecations.json, and the config files of configFailures.
 * It reads the text of each packed file for each form of the note, with no
 * regard to case (rulings 47 and 53 of the plan 12j lane). `marked` counts
 * each packed file with a form, except the code files of the lists, and
 * `listed` counts the files of the list.
 */
export function checkTarballs(
  root: string,
  paths: string[],
  lists: UnpublishedLists = UNPUBLISHED_LISTS,
  /** Gets the SHA-256 of each tarball that the check read, by its file name. */
  sums?: Map<string, string>,
): Report {
  const released = new Set(releasedNames(root));
  const packages = readWorkspace(root).filter((p) => released.has(p.name));
  const dirs = new Map(packages.map((p) => [p.name, p.dir]));
  const scripts = new Map(packages.map((p) => [p.name, p.manifest.scripts ?? {}]));
  const versions = [...new Set(packages.map((p) => p.manifest.version))];
  const needs = JSON.parse(readFileSync(join(root, "release/pack-needs.json"), "utf8")) as Record<
    string,
    string[]
  >;
  const { url } = JSON.parse(readFileSync(join(root, "release/repository.json"), "utf8")) as {
    url: string;
  };
  const rootLicense = readFileSync(join(root, "LICENSE"), "utf8");
  // The register is required: it is the one source of core's authtempo.deprecations.
  const deprecations = readDeprecations(root);

  const failures: string[] = [];
  if (versions.length !== 1)
    failures.push(`the released packages hold ${versions.length} versions: ${versions.join(", ")}`);
  failures.push(...configFailures(root, packages));
  const seen = new Set<string>();
  let files = 0;
  /** Each packed file, and each packed file with a note form, by the path from the root. */
  const packed: string[] = [];
  const marked = new Map<string, string[]>();
  for (const path of paths) {
    let t: Tarball;
    try {
      t = readTarball(path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (sums?.has(basename(path)) === true)
      failures.push(`${path}: a second tarball with the file name ${basename(path)}`);
    sums?.set(basename(path), t.sha256);
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
    const texts = packedTexts(t.bytes, t.files);
    const constant = VERSION_CONSTANTS[name];
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
      scripts: (scripts.get(name) ?? {}) as Record<string, unknown>,
      ...(constant === undefined ? {} : { versionText: texts.get(constant.file) ?? null }),
    });
    files += t.files.length;
    for (const f of r.failures) failures.push(`${name}@${t.manifest.version}: ${f}`);
    packed.push(...t.files.map((f) => `${dir}/${f}`));
    for (const [f, text] of texts) {
      const forms = noteForms(text);
      if (forms.length > 0) marked.set(`${dir}/${f}`, forms);
      const local = LOCAL_PATH.exec(text);
      if (local !== null)
        failures.push(
          `${name}@${t.manifest.version}: ${f} holds the local machine path ${local[0]}`,
        );
    }
  }
  const code = new Set(lists.code.map((c) => c.path));
  failures.push(
    ...unpublishedFailures({
      version: versions[0] ?? "",
      packed,
      marked,
      lists,
      exists: (p) => existsSync(join(root, p)),
    }),
  );
  // A dry run that packs 23 of 24 packages must fail here, not on npm.
  for (const name of released) if (!seen.has(name)) failures.push(`${name}: no tarball`);
  return requireCounts(
    {
      name: "check-pack",
      counts: {
        tarballs: seen.size,
        files,
        marked: [...marked.keys()].filter((p) => !code.has(p)).length,
        listed: lists.files.length,
      },
      failures,
      notes: [],
    },
    ["tarballs", "files"],
  );
}

/**
 * The SHA-256 list of the tarballs in the form of sha256sum: the hash, two
 * spaces, and the file name, one line each, in name order.
 */
export const sumsText = (sums: ReadonlyMap<string, string>): string =>
  [...sums]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, sha]) => `${sha}  ${file}\n`)
    .join("");

/**
 * Runs the check on the tree at `root`. A source that the check cannot read,
 * such as a missing or bad release/deprecations.json, gives a FAIL summary
 * line with the reason, not a stack. With `sumsFile`, a PASS writes the
 * SHA-256 list of the bytes that the check read there (ruling 67 of plan
 * 12j, Low 4), and a FAIL leaves no list.
 */
export function entry(
  root: string,
  paths: string[],
  lists: UnpublishedLists = UNPUBLISHED_LISTS,
  sumsFile?: string,
): { lines: string[]; code: number } {
  let report: Report;
  const sums = new Map<string, string>();
  if (sumsFile !== undefined) rmSync(sumsFile, { force: true });
  try {
    report = checkTarballs(root, paths, lists, sums);
  } catch (error) {
    report = unreadReport(
      "check-pack",
      ["tarballs", "files", "marked", "listed"],
      error instanceof Error ? error.message : String(error),
    );
  }
  const code = report.failures.length > 0 ? 1 : 0;
  if (sumsFile !== undefined && code === 0) writeFileSync(sumsFile, sumsText(sums));
  return { lines: reportLines(report), code };
}

if (import.meta.main) {
  // node check-pack.ts [--sums <file>] <tarball>...
  const args = process.argv.slice(2);
  const at = args.indexOf("--sums");
  const sumsFile = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && (sumsFile === undefined || sumsFile.startsWith("--"))) {
    console.log("check-pack: FAIL tarballs=0 files=0 marked=0 listed=0 failures=1");
    console.log("  --sums needs the path of the SHA-256 list");
    process.exit(2);
  }
  const paths = at === -1 ? args : args.filter((_a, i) => i !== at && i !== at + 1);
  const { lines, code } = entry(
    fileURLToPath(new URL("../../../", import.meta.url)),
    paths,
    UNPUBLISHED_LISTS,
    sumsFile,
  );
  for (const line of lines) console.log(line);
  process.exit(code);
}
