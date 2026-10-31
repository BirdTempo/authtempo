// check-deprecations-page (plan 12j Task 13, spec 33 item 8). The page
// /docs/reference/deprecations/ against the register release/deprecations.json,
// both ways. Each entry has its section `### <id>` under "The entries", with
// its `what` text, its since, and its removeIn, and the built page has the
// anchor that the register's `docs` field and `authtempo upgrade` link. Each
// section of the page is an entry of the register. A section twice, or a
// section with two since or two removeIn lines, fails.
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The page, by its path under src/content/docs/. */
export const DEPRECATIONS_PAGE = "docs/reference/deprecations.md";
/** The part of the page that holds one `### <id>` section per entry. */
const ENTRIES = "## The entries";

/** The fields of a register entry that the page states. */
export interface RegisterEntry {
  id: string;
  what: string;
  since: string;
  removeIn: string;
}

export interface DeprecationsPageInput {
  register: readonly RegisterEntry[];
  /** The source of the page, or "" when it is missing. */
  source: string;
  /** The built HTML of /docs/reference/deprecations/, or "" when the build lacks it. */
  built: string;
}

/** Each `### ` section under ENTRIES, with its heading, in page order. */
function sections(source: string): { heading: string; body: string }[] {
  const start = source.indexOf(`\n${ENTRIES}\n`);
  if (start === -1) return [];
  const rest = source.slice(start + ENTRIES.length + 2);
  const end = rest.search(/^## /m);
  const part = end === -1 ? rest : rest.slice(0, end);
  return part
    .split(/^### /m)
    .slice(1)
    .map((block) => {
      const [heading = "", ...body] = block.split("\n");
      return { heading: heading.trim(), body: body.join("\n").trim() };
    });
}

export function checkDeprecationsPage(input: DeprecationsPageInput): CheckReport {
  const { register, source, built } = input;
  const r: CheckReport = {
    name: "check-deprecations-page",
    counts: { entries: register.length, sections: 0, anchors: 0 },
    failures: [],
  };
  if (source === "") r.failures.push(`${DEPRECATIONS_PAGE} does not exist`);
  const list = sections(source);
  r.counts.sections = list.length;
  const found = new Map<string, string>();
  for (const { heading, body } of list) {
    if (found.has(heading))
      r.failures.push(`${DEPRECATIONS_PAGE} has the section "### ${heading}" twice`);
    else found.set(heading, body);
  }
  for (const e of register) {
    const body = found.get(e.id);
    if (body === undefined) {
      r.failures.push(`${DEPRECATIONS_PAGE} has no section "### ${e.id}" under "${ENTRIES}"`);
      continue;
    }
    const lines = body.split("\n").map((l) => l.trim());
    if (lines[0] !== e.what)
      r.failures.push(`${e.id}: the page text is not the what of the register: ${e.what}`);
    if (!lines.includes(`- Deprecated since: \`${e.since}\``))
      r.failures.push(`${e.id}: the page does not state "- Deprecated since: \`${e.since}\`"`);
    if (!lines.includes(`- Removed in: \`${e.removeIn}\``))
      r.failures.push(`${e.id}: the page does not state "- Removed in: \`${e.removeIn}\`"`);
    for (const lead of ["- Deprecated since:", "- Removed in:"]) {
      const n = lines.filter((l) => l.startsWith(lead)).length;
      if (n > 1) r.failures.push(`${e.id}: the section has ${n} lines "${lead}"; it has one`);
    }
    if (built.includes(`id="${e.id}"`)) r.counts.anchors = (r.counts.anchors ?? 0) + 1;
    else r.failures.push(`${e.id}: the built page has no anchor #${e.id}`);
  }
  const ids = new Set(register.map((e) => e.id));
  for (const heading of found.keys())
    if (!ids.has(heading))
      r.failures.push(
        `${DEPRECATIONS_PAGE} has the section "### ${heading}", which the register lacks`,
      );
  return requireCounts(r, ["entries", "sections"]);
}
