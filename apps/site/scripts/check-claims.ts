import { PRICE, textOfHtml } from "./check-facts.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * Each phrase that may name another product outside /compare/, with its
 * reason. Each one names the compatibility package of authtempo, which runs
 * an app of that product. It makes no claim about the product.
 */
export const ALLOWED_PHRASES: readonly string[] = [
  // The feature title of @authtempo/compat-better-auth (features.ts) and its row on /demo/.
  "Better Auth compatibility",
  // The feature line of that package (features.ts).
  "an app written for Better Auth",
  // The reason of that row on /demo/ (DEMO_OFF of @authtempo/demo/facts).
  "an app that moves from Better Auth",
];

/** A claim about a customer of authtempo: no page outside /compare/ holds one. */
const CLAIM = /\b(?:customers?|trusted by|used by|testimonials?|case stud(?:y|ies))\b/i;
/** An element that holds a quote or an image, as a logo of another company. */
const QUOTE_OR_IMAGE = /<(blockquote|q|img|picture|figure)\b/i;

/** The main element of a page, or null when the page has none. */
function mainOf(html: string): string | null {
  const open = /<main\b[^>]*>/.exec(html);
  if (open === null) return null;
  const end = html.indexOf("</main>", open.index);
  return end < 0 ? null : html.slice(open.index + open[0].length, end);
}

/**
 * Spec 24 item 4 outside /compare/ (final review m1 of plan 11b): no
 * customer, quote, logo of another company, or price of another company.
 * The rule reads the main element of each page. It fails:
 * 1. a price (the PRICE rule of check-facts);
 * 2. a blockquote, q, img, picture, or figure element;
 * 3. a name of `names` outside ALLOWED_PHRASES;
 * 4. a customer claim;
 * 5. a page with no main element, so the rule never reads nothing.
 */
export function checkClaims(input: {
  pages: ReadonlyMap<string, string>;
  names: readonly string[];
  allowed?: readonly string[];
}): CheckReport {
  const r: CheckReport = {
    name: "check-claims",
    counts: { pages: input.pages.size, names: input.names.length },
    failures: [],
  };
  const allowed = input.allowed ?? ALLOWED_PHRASES;
  for (const [path, html] of input.pages) {
    const main = mainOf(html);
    if (main === null) {
      r.failures.push(`${path} has no main element`);
      continue;
    }
    const element = QUOTE_OR_IMAGE.exec(main);
    if (element !== null) r.failures.push(`${path} has a ${element[1]?.toLowerCase()} element`);
    const text = textOfHtml(main).replace(/\s+/g, " ");
    const price = PRICE.exec(text);
    if (price !== null) r.failures.push(`${path} names a price: "${price[0].trim()}"`);
    const claim = CLAIM.exec(text);
    if (claim !== null) r.failures.push(`${path} makes a customer claim: "${claim[0]}"`);
    let rest = text;
    for (const phrase of allowed) rest = rest.split(phrase).join(" ");
    for (const name of input.names) {
      const at = new RegExp(
        `(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
      );
      if (at.test(rest)) r.failures.push(`${path} names ${name}`);
    }
  }
  return requireCounts(r, ["pages", "names"]);
}
