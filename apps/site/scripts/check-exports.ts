import { codeTexts } from "./lib/html.ts";
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
    const decl = DECLARATION.exec(line);
    if (decl?.[1]) names.add(decl[1]);
    else if (/^export\s+default\b/.test(line)) names.add("default");
    else unreadable.push(`${file}:${i + 1}: cannot read the export: ${line.trim()}`);
  });
  return { names: [...names].sort(), unreadable };
}

/** The exported names of an entry file, sorted. See `readExports` for the forms. */
export function exportNames(source: string): string[] {
  return readExports(source, "").names;
}

/** Every export of an entry appears as a code span on its reference page. */
export function checkExports(
  html: string,
  names: readonly string[],
  label: string,
  unreadable: readonly string[] = [],
): CheckReport {
  const code = codeTexts(html);
  const r: CheckReport = {
    name: `check-exports-${label}`,
    counts: { exports: names.length, found: 0 },
    failures: [...unreadable],
  };
  for (const n of names) {
    if (code.has(n)) r.counts.found = (r.counts.found ?? 0) + 1;
    else r.failures.push(`${label} export ${n} is not on the page`);
  }
  return requireCounts(r, ["exports"]);
}
