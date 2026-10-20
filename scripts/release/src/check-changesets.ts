import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangeset } from "./lib/changeset-file.ts";
import { changedFiles, commitCount, mergeBase, NoMergeBase, showAt } from "./lib/git.ts";
import { FIRST_RELEASE } from "./lib/release-facts.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, unreadReport } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

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
  /** The count of commits since the merge base. */
  commits: number;
  /** The version of the group in the working tree. */
  version: string;
}

/**
 * The files of a released package that need no changeset, each with its reason
 * (spec 33 item 2). A path is relative to the package folder. A row exempts no
 * file that the `files` field packs, unless the row says `packed: true`.
 */
export const EXEMPT_PATTERNS: readonly { pattern: RegExp; reason: string; packed?: true }[] = [
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
];

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
 * and `imports` change how Node loads dist. Rule 4 of .changeset/README.md
 * names the same keys, and a test holds the two lists equal.
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
  "type",
  "bin",
  "files",
  "engines",
] as const;

/** The runtime keys whose value differs between two manifest texts. A new or removed manifest changes each key. */
function runtimeChanges(base: string | null, head: string | null): string[] {
  if (base === null || head === null) return [...RUNTIME_KEYS];
  const a = JSON.parse(base) as Record<string, unknown>;
  const b = JSON.parse(head) as Record<string, unknown>;
  // The key order of `exports` decides which condition matches, so compare the JSON text.
  return RUNTIME_KEYS.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
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
  const bumps = new Set<string>();
  let empty = 0;
  for (const { file, text, onMain } of input.changesets) {
    // A changeset on main covers an earlier change. An edit on the branch does
    // not make it cover a new one.
    if (onMain === true) {
      notes.push(`${file} is on main at the merge base, so it covers no change of this branch`);
      // changeset version reads each changeset of the folder, so its bump counts for the first release.
      try {
        for (const { bump } of parseChangeset(text).releases) bumps.add(bump);
      } catch {
        // A file that does not parse failed on main, where it was new.
      }
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
      bumps.add(bump);
      if (released.has(name)) named.add(name);
      else failures.push(`${file} names ${name}, which is not a released package`);
      // From 0.x, changeset version writes 1.0.0 for a major, and only the
      // owner names 1.0.0 (spec 33 item 1.2).
      if (bump === "major" && input.version.startsWith("0."))
        failures.push(
          `${file} names ${name} as major; the group is at 0.x, so a break is a minor with a "Breaking:" line until the owner names 1.0.0`,
        );
    }
    // The body becomes the changelog entry, and a reader of the changelog
    // does not know the plan numbers.
    if (/^plan\s+\d/i.test(parsed.body))
      failures.push(
        `${file}: the body starts with a plan number; a changelog entry names the change, not the plan`,
      );
  }

  // At 0.0.0 a patch gives 0.0.1, and the first release is FIRST_RELEASE
  // (ruling 28 of the plan 12j lane). A major already fails above. The bumps
  // come from each changeset of the folder, new or on main.
  if (input.version === "0.0.0" && bumps.has("patch") && !bumps.has("minor") && !bumps.has("major"))
    failures.push(
      `the group is at 0.0.0 and the highest bump of the changesets is patch; the first release is ${FIRST_RELEASE}, so one changeset names a minor`,
    );

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

  let changed = 0;
  let covered = 0;
  let exempt = 0;
  const missing = new Map<string, string[]>();
  for (const file of input.changed) {
    const owner = ownerOf(file.path, input.dirs);
    if (owner === undefined || !released.has(owner[0])) continue;
    const [name, dir] = owner;
    const inner = file.path.slice(dir.length + 1);
    let label = file.path;
    // A file in the tarball changes what an app installs, so it is never exempt.
    const packed = packedBy(inner, files[name]);
    if (EXEMPT_PATTERNS.some((row) => row.pattern.test(inner) && (!packed || row.packed))) {
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
      path.endsWith("/package.json")
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
  const version = workspace.find((p) => released.includes(p.name))?.manifest.version;
  if (version === undefined) throw new Error("no released package is in the workspace");
  return {
    changed,
    changesets,
    released,
    dirs: Object.fromEntries(workspace.map((p) => [p.name, p.dir])),
    files: Object.fromEntries(workspace.map((p) => [p.name, p.manifest.files])),
    commits: commitCount(root, base),
    version,
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

/** Runs the check on the checkout at `root`, and returns the lines to print and the exit code. */
export function entry(root: string, ref: string): { lines: string[]; code: number } {
  let report: Report;
  try {
    report = checkChangesets(readInput(root, ref));
  } catch (error) {
    if (!(error instanceof NoMergeBase)) throw error;
    // With no merge base, changeset status has no commit to read from either.
    const keys = ["changed", "covered", "exempt", "empty"];
    return { lines: reportLines(unreadReport("check-changesets", keys, error.message)), code: 1 };
  }
  // Changesets runs beside the check as a note. Its exit code never decides.
  const status = spawnSync("pnpm", ["changeset", "status", `--since=${mergeBase(root, ref)}`], {
    cwd: root,
    encoding: "utf8",
  });
  report.notes.push(...statusNotes(status));
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
