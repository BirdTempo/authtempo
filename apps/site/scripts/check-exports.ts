import { columnCodes, sectionOf } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** What `readExports` found: the names, and each `export` line it could not turn into a name. */
export interface ExportRead {
  names: string[];
  /** One message per line, with the file and the line number. */
  unreadable: string[];
}

const DECLARATION =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+enum|function\*?|class|const|let|var|interface|enum|type|namespace)\s+([A-Za-z_$][\w$]*)/;

/**
 * The exported names of an entry file: `export { a, type B, c as d }`,
 * `export type { … }`, declarations, and `export default` (the name
 * `default`). A line that starts with `export` and fits none of these is
 * reported, never skipped: a skipped export would pass with no entry on its
 * page. `export *` is reported with the module it re-exports.
 */
export function readExports(source: string, file: string): ExportRead {
  const names = new Set<string>();
  const unreadable: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm))
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  source.split("\n").forEach((line, i) => {
    if (!/^export\b/.test(line) || /^export\s+(?:type\s+)?\{/.test(line)) return;
    const star =
      /^export\s+(?:type\s+)?\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s+["']([^"']+)["']/.exec(
        line,
      );
    if (star) {
      if (star[1]) names.add(star[1]);
      else
        unreadable.push(
          `${file}:${i + 1}: export * from "${star[2]}" re-exports names that this check cannot list`,
        );
      return;
    }
    // `export default class Foo` is imported as `default`, so only `default` counts.
    if (/^export\s+default\b/.test(line)) {
      names.add("default");
      return;
    }
    const decl = DECLARATION.exec(line);
    if (decl?.[1]) names.add(decl[1]);
    else unreadable.push(`${file}:${i + 1}: cannot read the export: ${line.trim()}`);
  });
  return { names: [...names].sort(), unreadable };
}

/** The exported names of an entry file, sorted. See `readExports` for the forms. */
export function exportNames(source: string): string[] {
  return readExports(source, "").names;
}

/**
 * The column headers of a table whose code spans are export names: an
 * "Export" table, the "Entry | Exports" form, and an "Area | Types" table.
 */
export const EXPORT_COLUMNS = ["Export", "Exports", "Types"] as const;

/**
 * Both directions, on the entry's own tables (plan 11d Task 15 review, M2 and
 * P5). `headings` names the sections of the page that hold the exports tables
 * of this entry. Every export is a code span in an export column of a table in
 * those sections, and every such code span is an export of this entry. A name
 * that is on the page for another reason, such as in the table of another
 * entry, does not count, and a removed or renamed export cannot stay.
 */
export function checkExports(
  html: string,
  read: ExportRead,
  label: string,
  headings: readonly string[],
): CheckReport {
  // `read` and `headings` are required, with no default: a caller cannot skip a direction.
  const { names, unreadable } = read;
  const r: CheckReport = {
    name: `check-exports-${label}`,
    counts: { exports: names.length, found: 0, rows: 0 },
    failures: [...unreadable],
  };
  const rows: string[] = [];
  for (const h of headings) {
    const part = sectionOf(html, h);
    if (part === null) r.failures.push(`${label} page has no heading ${h}`);
    else rows.push(...columnCodes(part, EXPORT_COLUMNS));
  }
  r.counts.rows = rows.length;
  const listed = new Set(rows);
  const exported = new Set(names);
  for (const n of names) {
    if (listed.has(n)) r.counts.found = (r.counts.found ?? 0) + 1;
    else r.failures.push(`${label} export ${n} is not in its exports table`);
  }
  for (const n of listed)
    if (!exported.has(n)) r.failures.push(`${label} row ${n} names no export of the entry`);
  return requireCounts(r, ["exports"]);
}
