import { codeTexts, columnCodes } from "./lib/html.ts";
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
 * The column headers of a page table whose code spans are export names: the
 * "Export" tables, the "Entry | Exports" table of a page with more than one
 * entry, and the "Area | Types" tables.
 */
export const EXPORT_COLUMNS = ["Export", "Exports", "Types"] as const;

/**
 * Both directions (plan 11d Task 15 review, M2). Every export of an entry
 * appears as a code span on its reference page. And every code span of an
 * export column of the page names an export of the page: `pageExports` is the
 * union of the exports of every entry that the page lists, so a removed or
 * renamed export cannot stay on its page.
 */
export function checkExports(
  html: string,
  read: ExportRead,
  label: string,
  pageExports: ReadonlySet<string>,
): CheckReport {
  // `read` and `pageExports` are required, with no default: a caller cannot skip a direction.
  const { names, unreadable } = read;
  const code = codeTexts(html);
  const rows = columnCodes(html, EXPORT_COLUMNS);
  const r: CheckReport = {
    name: `check-exports-${label}`,
    counts: { exports: names.length, found: 0, rows: rows.length },
    failures: [...unreadable],
  };
  for (const n of names) {
    if (code.has(n)) r.counts.found = (r.counts.found ?? 0) + 1;
    else r.failures.push(`${label} export ${n} is not on the page`);
  }
  for (const n of new Set(rows))
    if (!pageExports.has(n)) r.failures.push(`${label} page row ${n} names no export of the page`);
  return requireCounts(r, ["exports"]);
}
