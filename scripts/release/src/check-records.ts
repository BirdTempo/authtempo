import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitOf,
  filesAt,
  headCommit,
  isAncestor,
  lastReleaseTag,
  mergeBase,
  NoMergeBase,
  showAt,
  worktreeFiles,
} from "./lib/git.ts";
import { RECORDS_BASE, TAG_PREFIX } from "./lib/release-facts.ts";
import { type Report, reportLines, requireCounts, unreadReport } from "./lib/report.ts";
import { RunTimeout } from "./lib/run-sync.ts";

export interface RecordFile {
  path: string;
  /** The text at the merge base, or null when the file is new. */
  base: string | null;
  /** The text in the working tree, or null when the file is removed. */
  head: string | null;
}

/** How a record may change: a new section at the top, a new entry at the end, or no change. */
export type Growth = "top" | "end" | "never";

/**
 * The append-only records (spec 33 item 3) and the rule of each one. A changelog
 * grows at the top, because `changeset version` writes the new section there.
 * The advisory record grows at the end (Task 12). A shipped migration never
 * changes, because a database that ran it does not run it again.
 *
 * The spec, the plan index, the plan files, and the ledgers are records too.
 * No check holds them: a review holds them.
 */
export const RECORD_GLOBS: readonly {
  glob: string;
  kind: "changelogs" | "advisories" | "migrations";
  grows: Growth;
}[] = [
  { glob: "packages/*/CHANGELOG.md", kind: "changelogs", grows: "top" },
  { glob: "docs/security/advisories.md", kind: "advisories", grows: "end" },
  { glob: "packages/*/migrations/**", kind: "migrations", grows: "never" },
  { glob: "packages/*/src/migrations/**", kind: "migrations", grows: "never" },
];

/** A glob as a pattern: `*` is one path part, `**` is one or more parts. */
function globPattern(glob: string): RegExp {
  const parts = glob.split("/").map((part) => {
    if (part === "**") return ".+";
    return part
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+");
  });
  return new RegExp(`^${parts.join("/")}$`);
}

const PATTERNS = RECORD_GLOBS.map((row) => ({ ...row, pattern: globPattern(row.glob) }));

/** The row of RECORD_GLOBS that holds `path`, or undefined when the path is not a record. */
export function recordOf(path: string): (typeof RECORD_GLOBS)[number] | undefined {
  const row = PATTERNS.find((p) => p.pattern.test(path));
  return row === undefined ? undefined : { glob: row.glob, kind: row.kind, grows: row.grows };
}

interface Section {
  heading: string;
  /** The heading line and each line up to the next heading, with each line end. */
  text: string;
}

/** The text before the first `## ` heading, and each `## ` section. */
function sections(text: string): { title: string; list: Section[] } {
  let title = "";
  const list: Section[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    const last = list[list.length - 1];
    if (line.startsWith("## ")) list.push({ heading: line.trimEnd(), text: line });
    else if (last === undefined) title += line;
    else last.text += line;
  }
  return { title, list };
}

/** A changelog keeps its title and each old section with the same bytes, under each new section. */
function checkTop(
  path: string,
  base: string,
  head: string,
  label: string,
  failures: string[],
): void {
  const old = sections(base);
  const now = sections(head);
  if (now.title !== old.title) failures.push(`${path}: the title differs from ${label}`);
  for (const section of old.list) {
    const kept = now.list.find((s) => s.heading === section.heading);
    if (kept === undefined) {
      failures.push(`${path}: the section ${section.heading} is gone`);
      continue;
    }
    if (kept.text !== section.text)
      failures.push(`${path}: the section ${section.heading} differs from ${label}`);
  }
  const oldHeadings = new Set(old.list.map((s) => s.heading));
  const newest = now.list.findIndex((s) => oldHeadings.has(s.heading));
  if (newest !== -1)
    for (const [i, section] of now.list.entries())
      if (i > newest && !oldHeadings.has(section.heading))
        failures.push(
          `${path}: the new section ${section.heading} is below the old section ${now.list[newest]?.heading}`,
        );
  const order = now.list.filter((s) => oldHeadings.has(s.heading)).map((s) => s.heading);
  const want = old.list.map((s) => s.heading).filter((h) => order.includes(h));
  if (order.join("\n") !== want.join("\n"))
    failures.push(`${path}: the old sections are in another order`);
}

/** The input of checkRecords. */
export interface RecordsInput {
  /** Each record at the base and in the working tree. */
  files: RecordFile[];
  /** The base in a failure line. The default is "the merge base". */
  label?: string;
  /**
   * Each record at HEAD and in the working tree, when the base is older than
   * HEAD: a change that is not committed yet holds the rules against HEAD too.
   */
  sinceHead?: RecordFile[];
  notes?: string[];
}

/** The failures of each record of `files` against its base. */
function compare(files: readonly RecordFile[], label: string): string[] {
  const failures: string[] = [];
  for (const { path, base, head } of files) {
    const row = recordOf(path);
    if (row === undefined) throw new Error(`${path} matches no row of RECORD_GLOBS`);
    if (base === null || head === null) {
      if (head === null) failures.push(`${path}: the record is gone`);
      continue;
    }
    if (row.grows === "top") checkTop(path, base, head, label, failures);
    else if (row.grows === "end") {
      if (!head.startsWith(base))
        failures.push(
          `${path}: the text at ${label} is not the start of the text now; a new entry goes at the end`,
        );
    } else if (head !== base) failures.push(`${path}: the migration differs from ${label}`);
  }
  return failures;
}

/**
 * Each record at the base is in the working tree with the same bytes (spec 33
 * item 3). Each new part is where its rule puts it. A fault in an old entry
 * gets a correction in the next entry, never an edit.
 */
export function checkRecords(input: RecordsInput): Report {
  const counts = { files: 0, changelogs: 0, migrations: 0, advisories: 0 };
  for (const { path } of input.files) {
    const row = recordOf(path);
    if (row === undefined) throw new Error(`${path} matches no row of RECORD_GLOBS`);
    counts.files++;
    counts[row.kind]++;
  }
  const failures = compare(input.files, input.label ?? "the merge base");
  for (const f of compare(input.sinceHead ?? [], "HEAD"))
    if (!failures.includes(f)) failures.push(f);
  // The migrations count in files, so the rule holds before the first release
  // too, when no changelog exists.
  return requireCounts(
    { name: "check-records", counts, failures, notes: [...(input.notes ?? [])] },
    ["files"],
  );
}

/**
 * The base of the compare (ruling 67 of plan 12j, Major 2). A pull request
 * has a merge base before HEAD. A push to main and a tag of a main commit
 * have a merge base equal to HEAD, and a compare with HEAD reads no change.
 * So the base is then the newest release tag before HEAD, or `fallback`
 * (RECORDS_BASE) while no tag exists. The base is never HEAD.
 */
export function recordsBase(
  root: string,
  ref: string,
  fallback: string = RECORDS_BASE,
): { base: string; label: string; atHead: boolean; notes: string[] } {
  const merge = mergeBase(root, ref);
  const head = headCommit(root);
  if (merge !== head) return { base: merge, label: "the merge base", atHead: false, notes: [] };
  const tag = lastReleaseTag(root, TAG_PREFIX);
  if (tag !== null)
    return {
      base: tag,
      label: tag,
      atHead: true,
      notes: [`the merge base with ${ref} is HEAD, so the base is ${tag}, the newest release tag`],
    };
  const commit = commitOf(root, fallback);
  if (commit === null || !isAncestor(root, commit))
    throw new NoMergeBase(
      `the merge base with ${ref} is HEAD, no release tag exists, and RECORDS_BASE ${fallback} is not an ancestor of HEAD; fetch the full history (fetch-depth: 0)`,
    );
  if (commit === head)
    throw new NoMergeBase(
      `the merge base with ${ref} and RECORDS_BASE are both HEAD, so no record was compared; set RECORDS_BASE to a commit before HEAD`,
    );
  const short = commit.slice(0, 8);
  return {
    base: commit,
    label: `RECORDS_BASE ${short}`,
    atHead: true,
    notes: [
      `the merge base with ${ref} is HEAD and no release tag exists, so the base is RECORDS_BASE ${short}`,
    ],
  };
}

/** Each record path at `base` (git ls-tree) or in the working tree, with both texts. */
function recordsAt(root: string, base: string): RecordFile[] {
  const atBase = new Set(filesAt(root, base).filter((p) => recordOf(p) !== undefined));
  const atHead = new Set(worktreeFiles(root).filter((p) => recordOf(p) !== undefined));
  const paths = [...new Set([...atBase, ...atHead])].sort();
  return paths.map((path) => ({
    path,
    base: atBase.has(path) ? showAt(root, base, path) : null,
    head: atHead.has(path) ? readFileSync(join(root, path), "utf8") : null,
  }));
}

/**
 * Reads each record path at the base of recordsBase (git ls-tree), and in the
 * working tree, so a change that is not committed yet counts too. With a base
 * before a merge base of HEAD, it also reads each record at HEAD.
 */
export function readInput(
  root: string,
  ref: string,
  fallback: string = RECORDS_BASE,
): RecordsInput {
  const { base, label, atHead, notes } = recordsBase(root, ref, fallback);
  return {
    files: recordsAt(root, base),
    label,
    notes,
    ...(atHead ? { sinceHead: recordsAt(root, "HEAD") } : {}),
  };
}

/** Runs the check on the checkout at `root`, and returns the lines to print and the exit code. */
export function entry(
  root: string,
  ref: string,
  fallback: string = RECORDS_BASE,
): { lines: string[]; code: number } {
  let report: Report;
  try {
    report = checkRecords(readInput(root, ref, fallback));
  } catch (error) {
    // A git call past its limit gives a FAIL line that names the call, not a
    // stack (review of Task 1 of plan 12n, M1).
    if (!(error instanceof NoMergeBase || error instanceof RunTimeout)) throw error;
    report = unreadReport(
      "check-records",
      ["files", "changelogs", "migrations", "advisories"],
      error.message,
    );
  }
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
