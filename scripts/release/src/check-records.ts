import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { filesAt, mergeBase, showAt, worktreeFiles } from "./lib/git.ts";
import { type Report, requireCounts, summaryLine } from "./lib/report.ts";

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
function checkTop(path: string, base: string, head: string, failures: string[]): void {
  const old = sections(base);
  const now = sections(head);
  if (now.title !== old.title) failures.push(`${path}: the title differs from the merge base`);
  for (const section of old.list) {
    const kept = now.list.find((s) => s.heading === section.heading);
    if (kept === undefined) {
      failures.push(`${path}: the section ${section.heading} is gone`);
      continue;
    }
    if (kept.text !== section.text)
      failures.push(`${path}: the section ${section.heading} differs from the merge base`);
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

/**
 * Each record at the merge base of `main` is in the working tree with the same
 * bytes, and each new part is where its rule puts it (spec 33 item 3). A fault
 * in an old entry gets a correction in the next entry, never an edit.
 */
export function checkRecords(input: { files: RecordFile[] }): Report {
  const failures: string[] = [];
  const counts = { files: 0, changelogs: 0, migrations: 0, advisories: 0 };
  for (const { path, base, head } of input.files) {
    const row = recordOf(path);
    if (row === undefined) throw new Error(`${path} matches no row of RECORD_GLOBS`);
    counts.files++;
    counts[row.kind]++;
    if (base === null || head === null) {
      if (head === null) failures.push(`${path}: the record is gone`);
      continue;
    }
    if (row.grows === "top") checkTop(path, base, head, failures);
    else if (row.grows === "end") {
      if (!head.startsWith(base))
        failures.push(
          `${path}: the text at the merge base is not the start of the text now; a new entry goes at the end`,
        );
    } else if (head !== base) failures.push(`${path}: the migration differs from the merge base`);
  }
  // The migrations count in files, so the rule holds before the first release
  // too, when no changelog exists.
  return requireCounts({ name: "check-records", counts, failures, notes: [] }, ["files"]);
}

/**
 * Reads each record path at the merge base with `ref` (git ls-tree) and in the
 * working tree, so a change that is not committed yet counts too.
 */
export function readInput(root: string, ref: string): { files: RecordFile[] } {
  const base = mergeBase(root, ref);
  const atBase = new Set(filesAt(root, base).filter((p) => recordOf(p) !== undefined));
  const atHead = new Set(worktreeFiles(root).filter((p) => recordOf(p) !== undefined));
  const paths = [...new Set([...atBase, ...atHead])].sort();
  return {
    files: paths.map((path) => ({
      path,
      base: atBase.has(path) ? showAt(root, base, path) : null,
      head: atHead.has(path) ? readFileSync(join(root, path), "utf8") : null,
    })),
  };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = checkRecords(readInput(root, process.argv[2] ?? "main"));
  console.log(summaryLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  if (report.failures.length > 0) process.exit(1);
}
