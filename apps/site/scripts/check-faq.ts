import { pageUrl } from "./check-frontmatter.ts";
import { type Page, parseFrontmatter } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The FAQ page, by its path under src/content/docs/. */
export const FAQ_PAGE = "docs/faq.md";

/**
 * At least this many entries. The six questions that plan 11d2 Task 17 names,
 * and one more entry for each guide, give more; a page under this count has
 * lost entries.
 */
export const MIN_ENTRIES = 8;

/** The URL of each guide of docs/migrate/. The index is a chooser, not a guide. */
export function migrationGuides(pages: readonly Page[]): string[] {
  return pages
    .map((p) => p.path)
    .filter((p) => p.startsWith("docs/migrate/") && !/\/index\.mdx?$/.test(p))
    .map(pageUrl)
    .sort();
}

interface Entry {
  question: string;
  answer: string;
}

/** The `### <question>` entries of the `## Questions` part, each with the text up to the next heading. */
function entries(body: string): Entry[] {
  const out: Entry[] = [];
  let inPart = false;
  let current: Entry | null = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      inPart = line.trim() === "## Questions";
      current = null;
      continue;
    }
    if (!inPart) continue;
    if (line.startsWith("### ")) {
      current = { question: line.slice(4).trim(), answer: "" };
      out.push(current);
    } else if (current) current.answer += `${line}\n`;
  }
  return out;
}

/** The link targets of a markdown text. */
function hrefs(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
}

/**
 * The FAQ answers the questions of the migration guides and holds no fact of
 * its own: each answer links the guide section that holds the full fact. So a
 * new guide fails here until the FAQ has an entry that links it.
 */
export function checkFaq(faqSource: string, guides: readonly string[]): CheckReport {
  const body = parseFrontmatter(faqSource)?.body ?? "";
  const list = entries(body);
  const r: CheckReport = {
    name: "check-faq",
    counts: { entries: list.length, guides: guides.length },
    failures: [],
  };
  const linked = new Set<string>();
  for (const e of list) {
    if (!e.question.endsWith("?"))
      r.failures.push(`the question "${e.question}" does not end with ?`);
    const targets = hrefs(e.answer);
    if (targets.length === 0) r.failures.push(`the answer of "${e.question}" has no link`);
    for (const t of targets) linked.add(t.split("#")[0] ?? "");
  }
  for (const g of guides) if (!linked.has(g)) r.failures.push(`no answer links the guide ${g}`);
  if (list.length < MIN_ENTRIES)
    r.failures.push(`${list.length} entries; the page needs at least ${MIN_ENTRIES}`);
  return requireCounts(r, ["guides"]);
}
