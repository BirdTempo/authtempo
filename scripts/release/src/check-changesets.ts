import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { BREAKING, isBreaking, unreadBreaking } from "./check-pack.ts";
import { parseChangeset } from "./lib/changeset-file.ts";
import { changedFiles, commitCount, mergeBase, NoMergeBase, showAt } from "./lib/git.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, unreadReport } from "./lib/report.ts";
import { ROOT_INPUTS, type RootInput, rootInputOf } from "./lib/root-inputs.ts";
import { RunTimeout, runSync } from "./lib/run-sync.ts";
import { readWorkspace } from "./lib/workspace.ts";
import { rewrittenPaths } from "./rewrite-unpublished.ts";

export { parseChangeset };

export interface ChangedFile {
  /** The path relative to the repository root, with "/" as the separator. */
  path: string;
  /** For a package.json of a package: the text at the merge base, or null when absent there. */
  base?: string | null;
  /** For a package.json of a package: the text in the working tree, or null when removed. */
  head?: string | null;
}

export interface ChangesetsInput {
  /** Each path that differs between the merge base and the working tree. */
  changed: ChangedFile[];
  /**
   * Each changeset that is new or changed since the merge base. `onMain` is
   * true when the file is at the merge base too.
   */
  changesets: { file: string; text: string; onMain?: boolean }[];
  /** The released package names: the fixed group. */
  released: string[];
  /** The folder of each workspace package, by name. */
  dirs: Record<string, string>;
  /** The `files` field of each workspace package, by name; undefined when the manifest has none. */
  files: Record<string, readonly string[] | undefined>;
  /**
   * The `build` script of each workspace package, by name; undefined when the
   * manifest has none. With no map, a row with `unbuilt` exempts no file.
   */
  builds?: Record<string, string | undefined>;
  /** The count of commits since the merge base. */
  commits: number;
  /** The version of the group in the working tree. */
  version: string;
  /** The version of the group at the merge base, or null when no released package is there. */
  baseVersion?: string | null;
  /** Each file that rewrite-unpublished writes on the version branch, by its path from the root. */
  unpublished?: readonly string[];
  /** The root inputs of the release. The default is ROOT_INPUTS. */
  rootInputs?: readonly RootInput[];
}

/**
 * The files of a released package that need no changeset, each with its reason
 * (spec 33 item 2). A path is relative to the package folder. A row exempts no
 * file that the `files` field packs, unless the row says `packed: true`. A row
 * with `unbuilt: true` exempts a file only under a plain build of its package.
 * `plainBuild` reads that form, which names no file of the package's own
 * scripts/ folder.
 */
export const EXEMPT_PATTERNS: readonly {
  pattern: RegExp;
  reason: string;
  packed?: true;
  unbuilt?: true;
}[] = [
  // Each fixture of a released package is under test/, so this row holds it too.
  { pattern: /^test\//, reason: "a test or a fixture is not in the pack" },
  { pattern: /(^|\/)proof\//, reason: "a proof checks the pack and changes no runtime code" },
  { pattern: /^typetest\//, reason: "a typetest is not in the pack" },
  { pattern: /(^|\/)README\.md$/, reason: "the README changes the docs, not the code" },
  // The release branch removes each changeset, so without this row each
  // released package fails there. Only the changelog at the package root.
  {
    pattern: /^CHANGELOG\.md$/,
    reason: "changeset version writes it from the changesets; check-records holds it",
    // Each released package lists CHANGELOG.md in files (spec 33 item 3).
    packed: true,
  },
  // A vitest config at the package root runs the tests, as a test file does
  // (ruling 25 of plan 12n).
  {
    pattern: /^vitest(\.[\w-]+)?\.config\.ts$/,
    reason: "a vitest config runs the tests and is not in the pack",
  },
  // A script under scripts/ checks the package, such as check-seam-dts.mjs of
  // adapter-d1 (ruling 28 of plan 12n). packedBy reads the files field, so a
  // packed script still needs a changeset. A build that runs a script of the
  // package writes dist with it, as the CLI does with copy-templates.mjs. So
  // the row exempts no file under scripts/ of such a package. A build that the
  // check cannot read as a plain form counts as such a build.
  {
    pattern: /^scripts\//,
    reason: "a script that the build does not run is not in the pack",
    unbuilt: true,
  },
];

/**
 * The programs that a plain build may start. node runs the file that it names,
 * and tsc compiles. A package manager, a shell, or another tool can run a
 * package script by its name, and the check does not read that script.
 */
const PLAIN_PROGRAMS = new Set(["node", "tsc"]);

/** A word of a plain build. A quote, `=`, `$`, or a leading `/` makes no plain word. */
const PLAIN_WORD = /^[\w@.+-][\w@./+-]*$/;

/**
 * True when the build of the package in `dir` is a plain form that names no
 * file of its own scripts/ folder. A plain form is a list of commands joined
 * by " && ". Each command is words with one space between them, and starts
 * with node or tsc. node takes no flag, so `node --run <name>` gives no plain
 * form. The check reads each word as a path from `dir`. Any other form fails
 * closed: the check counts it as a build that runs a script. A package with
 * no build runs no script. The rule comes from L3 of the review of the Task 1
 * fix of plan 12n.
 */
function plainBuild(build: string, dir: string): boolean {
  if (build === "") return true;
  const own = `${dir}/scripts`;
  return build.split(" && ").every((command) => {
    const [program, ...words] = command.split(" ");
    if (program === undefined || !PLAIN_PROGRAMS.has(program)) return false;
    if (!words.every((w) => PLAIN_WORD.test(w))) return false;
    if (program === "node" && words.some((w) => w.startsWith("-"))) return false;
    return words.every((w) => {
      const path = posix.join(dir, w);
      return path !== own && !path.startsWith(`${own}/`);
    });
  });
}

/** A files entry that the check reads: folder names and file names with "/", and no glob. */
const PLAIN_PATH = /^[\w@-][\w@.-]*(\/[\w@.-]+)*$/;

/**
 * True when the `files` field packs `inner`. An entry packs the path that it
 * names and each path below it. With no `files` field, the pack holds each file.
 */
function packedBy(inner: string, files: readonly string[] | undefined): boolean {
  if (files === undefined) return true;
  return files.some((entry) => inner === entry || inner.startsWith(`${entry}/`));
}

/**
 * The keys of package.json that change what an app installs or loads. `type`
 * and `imports` change how Node loads dist. `typesVersions` changes which
 * types TypeScript reads (ruling 64 of plan 12j, Minor 3). `scripts` ships in
 * the packed manifest, and an install script runs on each app (ruling 67 of
 * plan 12j, Low 1). Rule 4 of .changeset/README.md names the same keys, and a
 * test holds the two lists equal.
 */
export const RUNTIME_KEYS = [
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "exports",
  "imports",
  "main",
  "types",
  "typesVersions",
  "type",
  "bin",
  "files",
  "engines",
  "scripts",
] as const;

/**
 * The pin of the compiler in a released manifest. Each released package
 * builds dist with tsc of its own `typescript` pin. A new pin can change the
 * bytes of dist with no change of source. So the pin counts as a runtime
 * change (follow-up 6 of plan 12j). It is a key of its own, not a part of
 * RUNTIME_KEYS: a change of each other dev dependency still needs no
 * changeset. The lockfile and turbo.json stay out of ROOT_INPUTS. A row for
 * them asks for a changeset of each released package at each bump of a dev
 * tool.
 */
export const COMPILER_PIN = "devDependencies.typescript";

/** The `typescript` pin of the devDependencies of a manifest, or undefined. */
const compilerPin = (manifest: Record<string, unknown>) =>
  (manifest.devDependencies as Record<string, unknown> | undefined)?.typescript;

/** The runtime keys whose value differs between two manifest texts. A new or removed manifest changes each key. */
function runtimeChanges(base: string | null, head: string | null): string[] {
  if (base === null || head === null) return [...RUNTIME_KEYS];
  const a = JSON.parse(base) as Record<string, unknown>;
  const b = JSON.parse(head) as Record<string, unknown>;
  // The key order of `exports` decides which condition matches, so compare the JSON text.
  const keys: string[] = RUNTIME_KEYS.filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
  if (compilerPin(a) !== compilerPin(b)) keys.push(COMPILER_PIN);
  return keys;
}

/** The keys of `keys` whose value differs between two JSON texts. A new or removed file changes each key. */
function keysChanged(keys: readonly string[], base: string | null, head: string | null): string[] {
  if (base === null || head === null) return [...keys];
  const a = JSON.parse(base) as Record<string, unknown>;
  const b = JSON.parse(head) as Record<string, unknown>;
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/** The workspace package that holds `path`: the longest folder that is a prefix. */
function ownerOf(path: string, dirs: Record<string, string>): [string, string] | undefined {
  let best: [string, string] | undefined;
  for (const [name, dir] of Object.entries(dirs))
    if (path.startsWith(`${dir}/`) && (best === undefined || dir.length > best[1].length))
      best = [name, dir];
  return best;
}

/**
 * Each change to a released package needs a changeset that names the package
 * (spec 33 item 2). `changeset status` of Changesets is not the guard: this
 * check decides.
 */
export function checkChangesets(input: ChangesetsInput): Report {
  const failures: string[] = [];
  const notes: string[] = [];
  const released = new Set(input.released);

  const named = new Set<string>();
  let empty = 0;
  for (const { file, text, onMain } of input.changesets) {
    // A changeset on main covers an earlier change. An edit on the branch does
    // not make it cover a new one.
    if (onMain === true) {
      notes.push(`${file} is on main at the merge base, so it covers no change of this branch`);
      continue;
    }
    let parsed: ReturnType<typeof parseChangeset>;
    try {
      parsed = parseChangeset(text);
    } catch (error) {
      failures.push(`${file}: ${(error as Error).message}`);
      continue;
    }
    if (parsed.releases.length === 0) {
      empty++;
      if (!/^No release: \S/.test(parsed.body))
        failures.push(`${file} names no package and has no line "No release: <reason>"`);
    }
    for (const { name, bump } of parsed.releases) {
      if (released.has(name)) named.add(name);
      else failures.push(`${file} names ${name}, which is not a released package`);
      // From 0.x, changeset version writes 1.0.0 for a major, and only the
      // owner names 1.0.0 (spec 33 item 1.2).
      if (bump === "major" && input.version.startsWith("0."))
        failures.push(
          `${file} names ${name} as major; the group is at 0.x, so a break is a minor with a "Breaking:" line until the owner names 1.0.0`,
        );
    }
    // upgrade prints the Breaking: lines of each minor that it crosses, so a
    // break in a patch reaches no app (ruling 67 of plan 12j, Major 3). At
    // 0.x a break is a minor; from 1.0.0 it is a major.
    const breakBump = input.version.startsWith("0.") ? "minor" : "major";
    const body = parsed.body.split("\n");
    if (body.some(isBreaking)) {
      if (parsed.releases.length === 0)
        failures.push(`${file} has a "Breaking:" line and names no package`);
      for (const { name, bump } of parsed.releases)
        if (bump !== breakBump)
          failures.push(
            `${file} has a "Breaking:" line and names ${name} as ${bump}; a break is a ${breakBump}`,
          );
    }
    // Changesets indents each later line of a change by two spaces and keeps
    // its marker. So an indented line, a list item, or a quote moves deeper,
    // and no reader finds it (ruling 77 of plan 12j, item 3).
    for (const line of body.filter(unreadBreaking))
      failures.push(
        `${file} names a break in a form that upgrade does not read: "${line.trim()}"; start the line with "${BREAKING}"`,
      );
    // The body becomes the changelog entry, and a reader of the changelog
    // does not know the plan numbers.
    if (/^plan\s+\d/i.test(parsed.body))
      failures.push(
        `${file}: the body starts with a plan number; a changelog entry names the change, not the plan`,
      );
  }

  // A glob or a "./" entry would need the full pack rules. The check does not
  // guess, so each file of the package then counts as packed.
  const files = { ...input.files };
  for (const name of input.released)
    for (const entry of files[name] ?? [])
      if (!PLAIN_PATH.test(entry)) {
        failures.push(
          `${name}: the files entry "${entry}" is not a plain path; the check reads only a plain path, so it exempts no file of the package`,
        );
        files[name] = undefined;
      }

  // The version branch moves the group version, and rewrite-unpublished
  // rewrites each file of its lists with no code change (rulings 47 and 50 of
  // the plan 12j lane). Its changesets are gone there, so without this
  // exemption the branch fails. Such a packed file needs a changeset on any
  // other branch, as each packed file does. check-pack holds the rewrite on
  // the tarballs.
  const versionStep =
    input.baseVersion !== undefined &&
    input.baseVersion !== null &&
    input.baseVersion !== input.version;
  const unpublished = new Set(versionStep ? (input.unpublished ?? []) : []);

  let changed = 0;
  let covered = 0;
  let exempt = 0;
  const missing = new Map<string, string[]>();
  for (const file of input.changed) {
    const owner = ownerOf(file.path, input.dirs);
    // A root input changes the tarballs of its names when prepare or a build
    // reads it (ruling 67 of plan 12j, Minor 1). One inside a released folder,
    // such as the D1 migrations that the SQLite build copies, changes its own
    // package too.
    const root = rootInputOf(file.path, input.rootInputs ?? ROOT_INPUTS);
    if (root !== undefined) {
      let label = file.path;
      if (root.keys !== undefined) {
        if (file.base === undefined || file.head === undefined)
          throw new Error(`${file.path}: the input needs the base and head texts of the file`);
        const keys = keysChanged(root.keys, file.base, file.head);
        if (keys.length === 0) {
          exempt++;
          continue;
        }
        label = `${file.path} (${keys.join(", ")})`;
      }
      changed++;
      const names = new Set(root.names === "all" ? input.released : root.names);
      if (owner !== undefined && released.has(owner[0])) names.add(owner[0]);
      const unnamed = [...names].filter((n) => !named.has(n));
      if (unnamed.length === 0) covered++;
      for (const name of unnamed) missing.set(name, [...(missing.get(name) ?? []), label]);
      continue;
    }
    if (owner === undefined || !released.has(owner[0])) continue;
    if (unpublished.has(file.path)) {
      exempt++;
      continue;
    }
    const [name, dir] = owner;
    const inner = file.path.slice(dir.length + 1);
    let label = file.path;
    // A file in the tarball changes what an app installs, so it is never exempt.
    const packed = packedBy(inner, files[name]);
    // With no build map, the check does not guess, so each build counts as one that runs a script.
    const builtWithScript =
      input.builds === undefined || !plainBuild(input.builds[name] ?? "", dir);
    if (
      EXEMPT_PATTERNS.some(
        (row) =>
          row.pattern.test(inner) &&
          (!packed || row.packed === true) &&
          !(row.unbuilt === true && builtWithScript),
      )
    ) {
      exempt++;
      continue;
    }
    if (inner === "package.json") {
      if (file.base === undefined || file.head === undefined)
        throw new Error(`${file.path}: the input needs the base and head texts of the manifest`);
      const keys = runtimeChanges(file.base, file.head);
      if (keys.length === 0) {
        exempt++;
        continue;
      }
      label = `${file.path} (${keys.join(", ")})`;
    }
    changed++;
    if (named.has(name)) covered++;
    else missing.set(name, [...(missing.get(name) ?? []), label]);
  }
  for (const [name, labels] of [...missing].sort(([a], [b]) => a.localeCompare(b)))
    failures.push(`${name} changes and no changeset names it: ${labels.join(", ")}`);

  // A diff that reads nothing looks the same as a branch with no change.
  if (input.changed.length === 0) {
    if (input.commits > 0)
      failures.push(
        `read 0 changed files on a branch with ${input.commits} commits since the merge base`,
      );
    else notes.push("no change since the merge base");
  }

  return {
    name: "check-changesets",
    counts: { changed, covered, exempt, empty },
    failures,
    notes,
  };
}

const CHANGESET_FILE = /^\.changeset\/[^/]+\.md$/;

/** The `build` script of a manifest, or undefined. */
function buildOf(manifest: Record<string, unknown>): string | undefined {
  const build = (manifest.scripts as Record<string, unknown> | undefined)?.build;
  return typeof build === "string" ? build : undefined;
}

/**
 * Reads the input of `checkChangesets` from the checkout at `root`, against the
 * merge base with `ref`. Each changeset that is new or changed since the merge
 * base is read, and `onMain` marks each one that is at the merge base too.
 */
export function readInput(root: string, ref: string): ChangesetsInput {
  const base = mergeBase(root, ref);
  const readHead = (path: string) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
  const paths = changedFiles(root, base);
  const changed = paths.map(
    (path): ChangedFile =>
      path.endsWith("/package.json") || rootInputOf(path)?.keys !== undefined
        ? { path, base: showAt(root, base, path), head: readHead(path) }
        : { path },
  );
  const changesets: ChangesetsInput["changesets"] = [];
  for (const path of paths) {
    if (!CHANGESET_FILE.test(path) || path === ".changeset/README.md") continue;
    const text = readHead(path);
    if (text !== null)
      changesets.push({ file: path, text, onMain: showAt(root, base, path) !== null });
  }
  const workspace = readWorkspace(root);
  const released = releasedNames(root);
  // check-packages holds one version for the group, so the first one is the group version.
  const first = workspace.find((p) => released.includes(p.name));
  if (first === undefined) throw new Error("no released package is in the workspace");
  const version = first.manifest.version;
  const baseManifest = showAt(root, base, `${first.dir}/package.json`);
  const baseVersion =
    baseManifest === null
      ? null
      : String((JSON.parse(baseManifest) as { version?: unknown }).version);
  return {
    changed,
    changesets,
    released,
    dirs: Object.fromEntries(workspace.map((p) => [p.name, p.dir])),
    files: Object.fromEntries(workspace.map((p) => [p.name, p.manifest.files])),
    builds: Object.fromEntries(workspace.map((p) => [p.name, buildOf(p.manifest)])),
    commits: commitCount(root, base),
    version,
    baseVersion,
    unpublished: rewrittenPaths(),
  };
}

/**
 * The notes of one run of `changeset status`: the exit code, then each line of
 * its output, so a reader sees why it exited. The mark at a line start is dropped.
 */
export function statusNotes(run: {
  status: number | null;
  stdout: string;
  stderr: string;
}): string[] {
  const lines = `${run.stdout}\n${run.stderr}`
    .split("\n")
    .map((line) => line.replace(/^[^\x20-\x7e]+\s*/u, "").trim())
    .filter((line) => line !== "");
  return [
    `changeset status exited ${run.status ?? "with no code"}`,
    ...lines.map((line) => `changeset status: ${line}`),
  ];
}

/** The binary of Changesets that the root install links. */
const CHANGESET_BIN = "node_modules/.bin/changeset";

/**
 * The notes of `changeset status --since=<since>` in the checkout at `root`.
 * It runs the linked binary itself, not through pnpm. pnpm 12.8.1 installs
 * node_modules first in a checkout with none (review of Task 6, n1), and a
 * check never installs a package. With no binary, the note says so.
 */
export function changesetStatus(root: string, since: string): string[] {
  const bin = join(root, CHANGESET_BIN);
  if (!existsSync(bin))
    return [
      `changeset status: skipped, ${CHANGESET_BIN} is absent, and the check installs nothing`,
    ];
  let run: ReturnType<typeof runSync>;
  try {
    // changeset status is a Node tool as npm is, so it takes the limit of an npm read.
    run = runSync(bin, ["status", `--since=${since}`], { cwd: root, limit: "registry" });
  } catch (error) {
    // A note past its limit stays a note, because its result never decides
    // (review of Task 1 of plan 12n, M1).
    if (!(error instanceof RunTimeout)) throw error;
    return [`changeset status: ${error.message}`];
  }
  return statusNotes(run);
}

/** Runs the check on the checkout at `root`, and returns the lines to print and the exit code. */
export function entry(root: string, ref: string): { lines: string[]; code: number } {
  let report: Report;
  let base: string;
  try {
    report = checkChangesets(readInput(root, ref));
    base = mergeBase(root, ref);
  } catch (error) {
    // A git call past its limit gives a FAIL line that names the call, not a
    // stack (review of Task 1 of plan 12n, M1).
    if (!(error instanceof NoMergeBase || error instanceof RunTimeout)) throw error;
    // With no merge base, changeset status has no commit to read from either.
    const keys = ["changed", "covered", "exempt", "empty"];
    return { lines: reportLines(unreadReport("check-changesets", keys, error.message)), code: 1 };
  }
  // Changesets runs beside the check as a note. Its exit code never decides.
  report.notes.push(...changesetStatus(root, base));
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = entry(
    fileURLToPath(new URL("../../../", import.meta.url)),
    process.argv[2] ?? "main",
  );
  for (const line of lines) console.log(line);
  process.exit(code);
}
