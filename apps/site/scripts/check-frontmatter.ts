import { type Page, parseFrontmatter } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

export const TYPES = ["tutorial", "how-to", "reference", "explanation"] as const;

/** The page template of spec 18, in this order. A how-to guide also has "## If it fails". */
const TEMPLATE = ["**For:**", "**What it does:**", "## Before you start", "## Next"] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every page has a title, a description, one of the four types, and at least
 * one source; every source names a repo file that exists and, when it names a
 * section, a heading that the file has; and the body holds the template parts.
 * A source is `<repo path>`, `<repo path> <section number>`, or
 * `<repo path> "<heading text>"`.
 */
export function checkFrontmatter(
  pages: readonly Page[],
  read: (repoPath: string) => string | null,
): CheckReport {
  const r: CheckReport = {
    name: "check-frontmatter",
    counts: { pages: pages.length, sources: 0 },
    failures: [],
  };
  for (const p of pages) {
    const fm = parseFrontmatter(p.source);
    if (!fm) {
      r.failures.push(`${p.path}: has no frontmatter`);
      continue;
    }
    for (const key of ["title", "description", "type"] as const)
      if (!fm.fields[key]) r.failures.push(`${p.path}: has no ${key}`);
    const type = fm.fields.type;
    if (type && !(TYPES as readonly string[]).includes(type))
      r.failures.push(`${p.path}: type ${type} is not one of ${TYPES.join(", ")}`);
    const sources = fm.lists.sources ?? [];
    if (sources.length === 0) r.failures.push(`${p.path}: has no sources`);
    for (const source of sources) {
      r.counts.sources = (r.counts.sources ?? 0) + 1;
      const m = /^(\S+)(?:\s+(.+))?$/.exec(source);
      const path = m?.[1] ?? "";
      const section = m?.[2];
      const text = read(path);
      if (text === null) {
        r.failures.push(`${p.path}: source ${path} does not exist`);
        continue;
      }
      if (section === undefined) continue;
      const quoted = /^"(.+)"$/.exec(section);
      const found = quoted
        ? text.split("\n").some((l) => l.startsWith("#") && l.includes(quoted[1] ?? ""))
        : /^\d+(\.\d+)?$/.test(section)
          ? new RegExp(`^#{2,4} ${escapeRegExp(section)}[. ]`, "m").test(text)
          : null;
      if (found === null)
        r.failures.push(
          `${p.path}: source "${source}" must name a section by number or by a quoted heading`,
        );
      else if (!found)
        r.failures.push(`${p.path}: source ${path} has no heading ${quoted?.[1] ?? section}`);
    }
    const lines = fm.body.split("\n").map((l) => l.trim());
    const parts =
      type === "how-to" ? [...TEMPLATE.slice(0, 3), "## If it fails", "## Next"] : [...TEMPLATE];
    for (const part of parts)
      if (!lines.some((l) => l.startsWith(part)))
        r.failures.push(`${p.path}: lacks the template part ${part}`);
  }
  return requireCounts(r, ["pages", "sources"]);
}
