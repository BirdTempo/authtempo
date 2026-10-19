import {
  type CompareRow,
  type CompareSide,
  FACT_MAX_DAYS,
  type HostedModel,
} from "../src/data/compare.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

const DAY_MS = 86_400_000;
const SIDES: readonly CompareSide[] = ["authtempo", "parity", "better-auth"];
/**
 * A price: a currency sign, code, or word before or after a number. Each
 * tag of the text is a space, so "$<span>25</span>" reads as "$ 25", and
 * a cell never joins the word of the next cell.
 */
const PRICE = new RegExp(
  [
    String.raw`[$€£¥]\s*\d[\d.,]*`,
    String.raw`\d[\d.,]*\s*[$€£¥]`,
    String.raw`\b(?:USD|EUR|GBP|JPY)\s*\d[\d.,]*`,
    String.raw`\d[\d.,]*\s*(?:USD|EUR|GBP|JPY)\b`,
    String.raw`\d[\d.,]*\s*(?:US\s+)?(?:dollars?|euros?|pounds?|yen)\b`,
  ].join("|"),
  "i",
);
/** The currency entities, so "&#36;25" reads as "$25". */
const ENTITIES: Readonly<Record<string, string>> = {
  "&#36;": "$",
  "&#x24;": "$",
  "&dollar;": "$",
  "&euro;": "€",
  "&#8364;": "€",
  "&pound;": "£",
  "&#163;": "£",
  "&yen;": "¥",
  "&#165;": "¥",
};

/** The day number of an ISO date, or null when the text is not a real calendar day. */
function dayOf(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Date.UTC rolls 2026-02-30 over to March, so the round trip finds a false day.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return null;
  return t / DAY_MS;
}

/** The table row of an id on the built page, from its open tag to its close tag. */
function rowHtml(built: string, id: string): string {
  return built.split(` id="${id}"`)[1]?.split("</tr>")[0] ?? "";
}

/**
 * The dated facts of /compare/ (plan 11b Task 6, owner decision 3). The rules:
 * 1. Each row and each model has a source and a read date of the form
 *    YYYY-MM-DD. A date more than FACT_MAX_DAYS before `today`, or after it,
 *    fails. `today` is a UTC day: check.ts passes the build time.
 * 2. Each id is unique. Each side has one row at least, so the page states
 *    both sides (deviation 14).
 * 3. Each importer names a member of `providers`, and each member has a
 *    model with its importer. Each guide is a page of the build.
 * 4. The built page has one `cmp-<id>` per row and one `host-<provider>` per
 *    model, each with "Read <date>", and no other such id. It has a main
 *    element, and its text names no price.
 */
export function checkFacts(input: {
  rows: readonly CompareRow[];
  models: readonly HostedModel[];
  providers: readonly string[];
  built: string;
  files: ReadonlySet<string>;
  today: Date;
}): CheckReport {
  const r: CheckReport = {
    name: "check-facts",
    counts: { rows: input.rows.length, models: input.models.length, oldest_days: 0 },
    failures: [],
  };
  const today = Math.floor(input.today.getTime() / DAY_MS);
  const todayIso = new Date(today * DAY_MS).toISOString().slice(0, 10);
  const facts = [
    ...input.rows.map((x) => ({ id: `cmp-${x.id}`, source: x.source, read: x.read })),
    ...input.models.map((m) => ({ id: `host-${m.provider}`, source: m.source, read: m.read })),
  ];
  const seen = new Map<string, number>();
  for (const f of facts) seen.set(f.id, (seen.get(f.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) r.failures.push(`${id} is the id of ${n} rows`);
  for (const f of facts) {
    if (f.source.trim() === "") r.failures.push(`${f.id} names no source`);
    const day = dayOf(f.read);
    if (day === null) {
      r.failures.push(`${f.id} has the read date "${f.read}", not a YYYY-MM-DD day`);
      continue;
    }
    const age = today - day;
    if (age > FACT_MAX_DAYS)
      r.failures.push(`${f.id} was read ${age} days ago; the limit is ${FACT_MAX_DAYS}`);
    if (age < 0) r.failures.push(`${f.id} was read on ${f.read}, after the build day ${todayIso}`);
    r.counts.oldest_days = Math.max(r.counts.oldest_days ?? 0, age);
  }
  for (const side of SIDES)
    if (!input.rows.some((x) => x.side === side)) r.failures.push(`no row has the side "${side}"`);

  const providers = new Set(input.providers);
  const imported = new Set<string>();
  for (const m of input.models) {
    if (m.importer !== null) {
      const name = /^authtempo import (\S+)$/.exec(m.importer)?.[1] ?? "";
      if (!providers.has(name))
        r.failures.push(
          `host-${m.provider} names "${m.importer}", and ${name} is not a member of PROVIDERS`,
        );
      imported.add(name);
    }
    if (!input.files.has(`${m.guide.replace(/^\//, "")}index.html`))
      r.failures.push(`host-${m.provider} links ${m.guide}, which is not a page of the build`);
  }
  for (const p of input.providers)
    if (!imported.has(p))
      r.failures.push(`${p} is a member of PROVIDERS, and no hosted row names its importer`);

  const onPage = new Map<string, number>();
  for (const m of input.built.matchAll(/ id="((?:cmp|host)-[^"]*)"/g))
    onPage.set(m[1] ?? "", (onPage.get(m[1] ?? "") ?? 0) + 1);
  for (const f of facts) {
    const n = onPage.get(f.id) ?? 0;
    if (n === 0) r.failures.push(`the page has no ${f.id}`);
    else if (n > 1) r.failures.push(`the page has ${f.id} ${n} times`);
    else if (!rowHtml(input.built, f.id).includes(`Read ${f.read}`))
      r.failures.push(`${f.id}: the page does not say Read ${f.read}`);
  }
  for (const id of onPage.keys())
    if (!seen.has(id)) r.failures.push(`the page has ${id}, and no row names it`);
  // A page with no main element would hide a price from this rule, so it fails.
  const main = input.built.split('<main id="main"')[1]?.split("</main>")[0];
  if (main === undefined) r.failures.push('the page has no <main id="main"> element');
  const text = (main ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#?\w+;/g, (e) => ENTITIES[e.toLowerCase()] ?? e);
  const price = PRICE.exec(text);
  if (price !== null) r.failures.push(`the page names a price: "${price[0].trim()}"`);
  return requireCounts(r, ["rows", "models"]);
}
