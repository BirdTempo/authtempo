import { type Page, parseFrontmatter } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * The least count of entries in the collection `site` (ruling 9 of the plan
 * 11b lane). The home has no entry (ruling 5). The count was 0 at Task 2.
 * Task 4 adds features.md, and Task 5 adds pricing.md and security.md. Each task that adds an entry raises this number in
 * the same commit, so a lost entry fails here. Task 13 holds it to the root
 * pages that plan 11b lists.
 */
export const MINIMUM_ENTRIES = 3;

/**
 * The root pages that need no entry, by built file, each with its reason.
 * The check prints each one, so a reader sees every exemption.
 */
export const ENTRY_EXEMPT: Readonly<Record<string, string>> = {
  "index.html":
    "the home keeps the page of plan 11b1, built from HOME (ruling 5 of the plan 11b lane); homeProsePage() holds its prose",
};

/** The URL path of a built root page: index.html is /, and features/index.html is /features/. */
function urlOf(file: string): string {
  return `/${file.replace(/(^|\/)index\.html$/, "$1")}`;
}

/** Each tag of a kind, as its attribute text. */
function tagAttrs(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map((m) => m[1] ?? "");
}

/** The value of one attribute in an attribute text, or null when it is absent. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(attrs);
  return m ? (m[1] ?? "") : null;
}

/** The text of an HTML fragment: no tags, the five named entities read, the spaces joined. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The root pages of plan 11b and the prose of the collection `site`.
 * 1. Each root page has a <title>, a description meta with a content, the
 *    viewport meta, and the class site-header of the root layout.
 * 2. No root page holds data-pagefind-body: the search reads the docs only.
 * 3. Each entry names a root page, and that page's h1 is the entry's title.
 *    Each root page has one entry, except a page of ENTRY_EXEMPT.
 * 4. It reads at least one root page, and at least `minimum` entries. The
 *    CHECKS row passes MINIMUM_ENTRIES, so the row names the constant.
 */
export function checkSitePages(
  sources: readonly Page[],
  built: ReadonlyMap<string, string>,
  minimum: number,
): CheckReport {
  const r: CheckReport = {
    name: "check-site-pages",
    counts: { pages: built.size, entries: sources.length },
    failures: [],
    exempt: Object.entries(ENTRY_EXEMPT).map(([file, why]) => `${urlOf(file)} (${file}): ${why}`),
  };
  for (const [file, html] of built) {
    if (!/<title>[^<]*\S[^<]*<\/title>/.test(html)) r.failures.push(`${file} has no <title>`);
    const metas = tagAttrs(html, "meta");
    if (!metas.some((m) => attr(m, "name") === "description" && attr(m, "content")?.trim()))
      r.failures.push(`${file} has no description meta with a content`);
    if (!metas.some((m) => attr(m, "name") === "viewport"))
      r.failures.push(`${file} has no viewport meta`);
    if (!/\sclass="(?:[^"]*\s)?site-header(?:\s[^"]*)?"/.test(html))
      r.failures.push(`${file} lacks the class site-header of the root layout`);
    if (html.includes("data-pagefind-body")) r.failures.push(`${file} holds data-pagefind-body`);
  }
  const fileOf = new Map([...built.keys()].map((file) => [urlOf(file), file]));
  const named = new Map<string, string>();
  for (const entry of sources) {
    const fields = parseFrontmatter(entry.source)?.fields ?? {};
    const page = fields.page;
    const title = fields.title ?? "";
    if (page === undefined) {
      r.failures.push(`${entry.path} names no page`);
      continue;
    }
    const file = fileOf.get(page);
    if (file === undefined) {
      r.failures.push(`${entry.path} names ${page}, which is not a root page`);
      continue;
    }
    const first = named.get(page);
    if (first !== undefined) {
      r.failures.push(`${entry.path} names ${page}, which ${first} also names`);
      continue;
    }
    named.set(page, entry.path);
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(built.get(file) ?? "");
    if (h1 === null)
      r.failures.push(`${entry.path}: ${page} has no h1; the entry title is "${title}"`);
    else if (textOf(h1[1] ?? "") !== title)
      r.failures.push(
        `${entry.path}: the h1 of ${page} is "${textOf(h1[1] ?? "")}", not the entry title "${title}"`,
      );
  }
  for (const [url, file] of fileOf)
    if (!named.has(url) && !(file in ENTRY_EXEMPT))
      r.failures.push(`${url} (${file}) has no entry in src/content/site/`);
  if (sources.length < minimum)
    r.failures.push(
      `entries=${sources.length} is below MINIMUM_ENTRIES=${minimum}; an entry is lost`,
    );
  return requireCounts(r, ["pages"]);
}
