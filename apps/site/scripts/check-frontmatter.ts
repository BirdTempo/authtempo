import { type Page, parseFrontmatter } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

export const TYPES = ["tutorial", "how-to", "reference", "explanation"] as const;

/** The page template of spec 18, in this order. A how-to guide also has "## If it fails". */
const TEMPLATE = ["**For:**", "**What it does:**", "## Before you start", "## Next"] as const;

/** Spec 18.3: the "Next" part holds one to three links. */
export const NEXT_MIN = 1;
export const NEXT_MAX = 3;

/**
 * Spec 18.3 gives each "Before you start" item a link. An item that names a
 * tool or an account is exempt (the dated line of 2026-10-14 in spec 18): the
 * reader installs the tool or opens the account at its supplier, and a link
 * to a supplier page breaks the day the supplier moves it. An item is exempt
 * when it starts with one of these prefixes, and the report lists each one.
 */
export const NO_LINK_PREFIXES = [
  "Node ",
  "pnpm ",
  "Bun ",
  "Docker",
  "The AWS CLI",
  "The Firebase CLI",
  "A Cloudflare account",
  "Workers Paid",
] as const;

/** A markdown link, or a raw HTML anchor with an href. */
const LINK = /\[[^\]]*\]\([^)\s]+\)|<a\s[^>]*href=/g;

function linksIn(text: string): number {
  return text.match(LINK)?.length ?? 0;
}

/** The lines of the `## <heading>` part, up to the next `## ` heading. */
function partLines(lines: readonly string[], heading: string): string[] | null {
  const at = lines.indexOf(heading);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, end < 0 ? lines.length : end);
}

/** The list items of a part. A line that is not a new item continues the item before it. */
function listItems(part: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of part) {
    if (line === "") continue;
    const m = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (m) items.push(m[1] ?? "");
    else if (items.length > 0) items[items.length - 1] = `${items.at(-1)} ${line}`;
    else items.push(line);
  }
  return items;
}

/** True when the item starts with a prefix as a whole word ("Docker" is not "Dockerfile"). */
/** The URL of a page: `docs/migrate/index.md` is `/docs/migrate/`, `docs/a/b.mdx` is `/docs/a/b/`. */
export function pageUrl(path: string): string {
  const bare = path.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
  return `/${bare}${bare === "" || bare.endsWith("/") ? "" : "/"}`;
}

/** The link targets of a text: markdown links and raw HTML anchors. */
function hrefsIn(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)|<a\s[^>]*href="([^"]*)"/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

/** True when the href names the page it is on, with or without an anchor. */
function isSelfLink(href: string, url: string): boolean {
  return href.startsWith("#") || href.split("#")[0] === url;
}

function isExempt(item: string): boolean {
  return NO_LINK_PREFIXES.some(
    (p) => item.startsWith(p) && (p.endsWith(" ") || !/^[A-Za-z0-9]/.test(item.slice(p.length))),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the line holds the text and no letter or digit follows it ("Task 3" is not "Task 30"). */
function endsHere(line: string, text: string): boolean {
  return new RegExp(`${escapeRegExp(text)}(?![A-Za-z0-9])`).test(line);
}

/**
 * Every page has a title, a description, one of the four types, and at least
 * one source; every source names a repo file that exists and, when it names a
 * section, a heading that the file has; and the body holds the template parts.
 * A source is `<repo path>`, `<repo path> <section number>`, or
 * `<repo path> "<heading text>"`. Spec 18.3: "Next" holds one to three links,
 * and each "Before you start" item has a link or names a tool or an account.
 */
export function checkFrontmatter(
  pages: readonly Page[],
  read: (repoPath: string) => string | null,
): CheckReport {
  const r: CheckReport = {
    name: "check-frontmatter",
    counts: { pages: pages.length, sources: 0, prerequisites: 0, exempt: 0 },
    failures: [],
    exempt: [],
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
        ? text.split("\n").some((l) => l.startsWith("#") && endsHere(l, quoted[1] ?? ""))
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
    let prev = -1;
    for (const part of parts) {
      const at = lines.findIndex((l) => l.startsWith(part));
      if (at < 0) r.failures.push(`${p.path}: lacks the template part ${part}`);
      else {
        if (at < prev) r.failures.push(`${p.path}: the template part ${part} is out of order`);
        prev = Math.max(prev, at);
      }
    }
    const before = partLines(lines, "## Before you start");
    for (const item of before ? listItems(before) : []) {
      r.counts.prerequisites = (r.counts.prerequisites ?? 0) + 1;
      // A prerequisite comes before the page, so a link to the page itself
      // points the reader at nothing new.
      const self = hrefsIn(item).filter((h) => isSelfLink(h, pageUrl(p.path)));
      for (const h of self)
        r.failures.push(`${p.path}: the Before you start item links ${h}, the page itself`);
      if (self.length > 0 || linksIn(item) > 0) continue;
      if (isExempt(item)) {
        r.counts.exempt = (r.counts.exempt ?? 0) + 1;
        r.exempt?.push(`${p.path}: ${item}`);
      } else
        r.failures.push(
          `${p.path}: the Before you start item "${item}" has no link and names no tool or account`,
        );
    }
    const next = partLines(lines, "## Next");
    if (next) {
      const n = linksIn(next.join("\n"));
      if (n < NEXT_MIN || n > NEXT_MAX)
        r.failures.push(`${p.path}: Next holds ${n} links (${NEXT_MIN} to ${NEXT_MAX})`);
    }
  }
  return requireCounts(r, ["pages", "sources", "prerequisites"]);
}
