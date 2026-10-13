import { codeTexts } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The exported names of an entry file: `export { a, type B, c as d }`, `export type { … }`, and declarations. */
export function exportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  for (const m of source.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g))
    if (m[1]) names.add(m[1]);
  return [...names].sort();
}

/** Every export of an entry appears as a code span on its reference page. */
export function checkExports(html: string, names: readonly string[], label: string): CheckReport {
  const code = codeTexts(html);
  const r: CheckReport = {
    name: `check-exports-${label}`,
    counts: { exports: names.length, found: 0 },
    failures: [],
  };
  for (const n of names) {
    if (code.has(n)) r.counts.found = (r.counts.found ?? 0) + 1;
    else r.failures.push(`${label} export ${n} is not on the page`);
  }
  return requireCounts(r, ["exports"]);
}
