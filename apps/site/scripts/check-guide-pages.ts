import type { IdpGuide } from "@authtempo/core";
import {
  approved,
  GUIDE_PAGE_PREFIX,
  guidePageMarkdown,
  guidePagePath,
  NOT_CHECKED,
} from "../src/data/guide-pages.ts";
import { PRICE } from "./check-facts.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The URL of a page from its path under the docs folder: `docs/guides/x.md` is `/docs/guides/x/`. */
function urlOf(path: string): string {
  return `/${path.replace(/\.mdx?$/, "")}/`;
}

/** The main element of a built page, or null when the page has none. */
function mainOf(html: string): string | null {
  // Starlight writes `<main data-pagefind-body ...>`. A test page writes `<main id="main">`.
  const open = /<main\b[^>]*>/.exec(html);
  if (open === null) return null;
  return html.slice(open.index + open[0].length).split("</main>")[0] ?? null;
}

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

/**
 * The text of a built page as a reader sees it. A block end is a space. An
 * inline tag is nothing, so a code span next to a full stop stays next to it.
 * The quotes and apostrophes that the markdown renderer makes curly are
 * straight again, so a guide text and the page compare by their words.
 */
function readerText(html: string): string {
  return html
    .replace(/<\/(?:li|p|tr|td|th|h[1-6]|div|section|ul|ol|table)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(\w+);/g, (m, n: string) => ENTITIES[n] ?? m)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

/** A record text with its white space as one space, as `readerText` gives the page. */
function norm(text: string): string {
  return approved(text).replace(/\s+/g, " ");
}

/** The marks that a guide record carries: each unconfirmed step and the unconfirmed launch. */
function reasonsOf(g: IdpGuide): string[] {
  return [
    ...g.steps.flatMap((s) => (s.unconfirmed === undefined ? [] : [s.unconfirmed])),
    ...(g.launchUnconfirmed === undefined ? [] : [g.launchUnconfirmed]),
  ];
}

/**
 * Plan 13a Task 15, cases "guide pages", "no claim", and the one source of the
 * guides. For each guide of GUIDES:
 * 1. the page file exists and equals the page that the record gives, so the
 *    record stays the one source (a text change in core fails until the pages
 *    are written again);
 * 2. the built page shows `checkedOn`, each step, each unconfirmed reason, and
 *    the sentence that no label was checked on a real tenant;
 * 3. the built page shows one `Unconfirmed:` mark for each unconfirmed entry of
 *    the record, no more and no fewer, so a mark is a mark and not a plain line.
 * Also: no page of the guide folder lacks its guide; and no new page names a
 * price (spec section 9). `extra` lists the other new pages by URL.
 */
export function checkGuidePages(input: {
  guides: readonly IdpGuide[];
  /** The page sources by their path under the docs folder. */
  sources: ReadonlyMap<string, string>;
  /** The built page of a URL, or "" when the build wrote none. */
  built: (url: string) => string;
  extra: readonly string[];
}): CheckReport {
  const r: CheckReport = {
    name: "check-guide-pages",
    counts: { guides: input.guides.length, pages: 0, marks: 0 },
    failures: [],
  };
  const owned = new Set(input.guides.map((g) => guidePagePath(g.id)));
  for (const path of input.sources.keys())
    if (path.startsWith(`docs/guides/${GUIDE_PAGE_PREFIX}`) && !owned.has(path))
      r.failures.push(`${path} has no guide in GUIDES`);
  for (const g of input.guides) {
    const path = guidePagePath(g.id);
    const url = urlOf(path);
    const source = input.sources.get(path);
    if (source === undefined) {
      r.failures.push(`${path} is missing`);
      continue;
    }
    r.counts.pages = (r.counts.pages ?? 0) + 1;
    if (source !== guidePageMarkdown(g))
      r.failures.push(`${path} differs from GUIDES; run node scripts/write-guide-pages.ts`);
    const html = input.built(url);
    const main = mainOf(html);
    if (main === null) {
      r.failures.push(`${url} is not built`);
      continue;
    }
    const text = readerText(main);
    const reasons = reasonsOf(g);
    r.counts.marks = (r.counts.marks ?? 0) + reasons.length;
    if (!text.includes(g.checkedOn)) r.failures.push(`${url} lacks the date ${g.checkedOn}`);
    if (!text.includes(NOT_CHECKED)) r.failures.push(`${url} lacks the sentence: ${NOT_CHECKED}`);
    for (const s of g.steps)
      if (!text.includes(norm(s.text))) r.failures.push(`${url} lacks the step: ${s.text}`);
    if (!text.includes(norm(g.launch))) r.failures.push(`${url} lacks the launch text`);
    for (const reason of reasons)
      if (!text.includes(norm(reason))) r.failures.push(`${url} lacks the mark: ${reason}`);
    const shown = text.split("Unconfirmed:").length - 1;
    if (shown !== reasons.length)
      r.failures.push(`${url} shows ${shown} Unconfirmed marks; the record has ${reasons.length}`);
    const price = PRICE.exec(text);
    if (price !== null) r.failures.push(`${url} names a price: "${price[0].trim()}"`);
  }
  for (const url of input.extra) {
    const main = mainOf(input.built(url));
    if (main === null) {
      r.failures.push(`${url} is not built`);
      continue;
    }
    r.counts.pages = (r.counts.pages ?? 0) + 1;
    const price = PRICE.exec(readerText(main));
    if (price !== null) r.failures.push(`${url} names a price: "${price[0].trim()}"`);
  }
  return requireCounts(r, ["guides", "pages"]);
}
