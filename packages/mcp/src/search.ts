// The search of docs.search: BM25 over the sections of the agent index, with
// no dependency. It runs on Node and on the remote Worker.
import type { AgentIndex, AgentPage } from "./index-format.js";

/** The common BM25 values (Robertson and Zaragoza, "The Probabilistic Relevance Framework"). */
export const BM25 = { k1: 1.2, b: 0.75 } as const;

/**
 * The weight of a match in each field of a section. A title or a heading
 * names the topic; the body only mentions it.
 */
export const FIELD_WEIGHTS = { title: 3, heading: 2, body: 1 } as const;

/** The longest snippet of a hit, in characters. */
export const SNIPPET_MAX = 300;

export interface SearchHit {
  path: string;
  title: string;
  heading: string;
  anchor: string | null;
  snippet: string;
  type: AgentPage["type"];
  score: number;
}

interface TermMap {
  /** Each forbidden phrase, as its tokens joined by one space, to the tokens of its approved term. */
  map: Map<string, string[]>;
  /** The most tokens in one phrase. */
  longest: number;
}

const termCache = new WeakMap<Readonly<Record<string, string>>, TermMap>();

/**
 * The one stem rule: a token of four or more characters that ends in "s",
 * and not in "ss", loses the "s". So "keys" meets "key" and "rotates" meets
 * "rotate". The rule applies to the query and to the docs alike, so a wrong
 * stem such as "statu" still matches itself.
 */
const stem = (t: string): string =>
  t.length >= 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;

const split = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map(stem);

function termMap(terms: Readonly<Record<string, string>>): TermMap {
  const hit = termCache.get(terms);
  if (hit) return hit;
  const map = new Map<string, string[]>();
  let longest = 1;
  for (const [word, use] of Object.entries(terms)) {
    const key = split(word);
    if (key.length === 0) continue;
    map.set(key.join(" "), split(use));
    longest = Math.max(longest, key.length);
  }
  const made = { map, longest };
  termCache.set(terms, made);
  return made;
}

/**
 * The tokens of a text: lower case, split on each character that is no
 * letter or digit, with the stem rule. A token, or a run of tokens up to the
 * longest phrase of `terms`, maps to the tokens of its approved term. So
 * "2FA" and "two factor" both give the tokens of "second factor". The longest
 * phrase matches first. The brief names pairs. A longer phrase such as "email
 * verification token" also maps, so no term of the glossary is dead.
 */
export function tokenize(text: string, terms: Readonly<Record<string, string>>): string[] {
  const raw = split(text);
  const { map, longest } = termMap(terms);
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    let matched = false;
    for (let n = Math.min(longest, raw.length - i); n >= 1; n -= 1) {
      const use = map.get(raw.slice(i, i + n).join(" "));
      if (use) {
        out.push(...use);
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(raw[i] ?? "");
      i += 1;
    }
  }
  return out;
}

/**
 * A link whose text is one route in a code span, such as
 * [`POST /reauth`](https://authtempo.com/docs/reference/routes/#post-reauth).
 */
const ROUTE_LINK = /\[`[A-Z]+ \/[^`]*`\]\([^)\s]*\)/g;

/**
 * The body text that the score reads (rulings 24, 29, and 39 of plan 12n).
 * The cut takes the route links of a table row only, so a route link there
 * gives no token. The other words of the row stay, the code links too. So a
 * longer list of route links does not move its section up, and a cell with
 * more prose still does. The section text of the index keeps each link,
 * because docs.read answers that text.
 */
function scoredText(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*\|/.test(line) ? line.replace(ROUTE_LINK, "") : line))
    .join("\n");
}

const FIELDS = ["title", "heading", "body"] as const;
type Field = (typeof FIELDS)[number];

interface Doc {
  /** The index of the page in index.pages: the sidebar order. */
  page: number;
  /** The index of the section in index.sections. */
  section: number;
  /** The count of each token in each field. */
  tf: Record<Field, Map<string, number>>;
  /** The number of tokens in each field. */
  length: Record<Field, number>;
}

interface Prepared {
  docs: Doc[];
  /** The number of sections that hold each token, in any field. */
  df: Map<string, number>;
  /** The mean length of each field. */
  avg: Record<Field, number>;
}

const prepCache = new WeakMap<AgentIndex, Prepared>();

function counts(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function prepare(index: AgentIndex): Prepared {
  const hit = prepCache.get(index);
  if (hit) return hit;
  const pageAt = new Map(index.pages.map((p, i) => [p.path, i]));
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  const total: Record<Field, number> = { title: 0, heading: 0, body: 0 };
  index.sections.forEach((s, i) => {
    const page = pageAt.get(s.path) ?? 0;
    const text: Record<Field, string> = {
      title: index.pages[page]?.title ?? "",
      heading: s.heading,
      body: scoredText(s.text),
    };
    const tokens = {
      title: tokenize(text.title, index.header.terms),
      heading: tokenize(text.heading, index.header.terms),
      body: tokenize(text.body, index.header.terms),
    };
    const doc: Doc = {
      page,
      section: i,
      tf: {
        title: counts(tokens.title),
        heading: counts(tokens.heading),
        body: counts(tokens.body),
      },
      length: {
        title: tokens.title.length,
        heading: tokens.heading.length,
        body: tokens.body.length,
      },
    };
    for (const f of FIELDS) total[f] += doc.length[f];
    for (const t of new Set([...tokens.title, ...tokens.heading, ...tokens.body]))
      df.set(t, (df.get(t) ?? 0) + 1);
    docs.push(doc);
  });
  const n = Math.max(docs.length, 1);
  const made = {
    docs,
    df,
    avg: { title: total.title / n, heading: total.heading / n, body: total.body / n },
  };
  prepCache.set(index, made);
  return made;
}

/**
 * The BM25F score of one section: each field's count is normalized by that
 * field's length, weighted, and summed before the k1 saturation. A long body
 * then does not dilute a title match, and a title match counts once per term.
 */
function scoreOf(doc: Doc, tokens: readonly string[], prep: Prepared): number {
  const n = prep.docs.length;
  let score = 0;
  for (const t of tokens) {
    let weighted = 0;
    for (const f of FIELDS) {
      const count = doc.tf[f].get(t) ?? 0;
      if (count === 0) continue;
      const avg = prep.avg[f] || 1;
      weighted += (FIELD_WEIGHTS[f] * count) / (1 - BM25.b + (BM25.b * doc.length[f]) / avg);
    }
    if (weighted === 0) continue;
    const d = prep.df.get(t) ?? 0;
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
    score += (idf * weighted * (BM25.k1 + 1)) / (weighted + BM25.k1);
  }
  return score;
}

/** The text of a section on one line, cut to SNIPPET_MAX characters at a word end. */
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  const cut = flat.slice(0, SNIPPET_MAX - 1);
  const end = cut.lastIndexOf(" ");
  return `${end > 0 ? cut.slice(0, end) : cut}…`;
}

/**
 * The text of a section. A section with no text of its own gives the text of
 * its first level-3 child. So a hit never has an empty snippet.
 */
function textOrChild(index: AgentIndex, at: number): string {
  const s = index.sections[at];
  const next = index.sections[at + 1];
  if (s && s.text.trim() === "" && next && next.path === s.path && next.depth === 3)
    return next.text;
  return s?.text ?? "";
}

/**
 * The best sections for a query, at most one per page and at most `limit`.
 * A higher score comes first; a tie follows the sidebar order, then the
 * order of the sections on the page. The same query gives the same order.
 */
export function searchSections(
  index: AgentIndex,
  query: string,
  opts: { limit: number; type?: AgentPage["type"] },
): SearchHit[] {
  const tokens = [...new Set(tokenize(query, index.header.terms))];
  if (tokens.length === 0) return [];
  const prep = prepare(index);
  const best = new Map<number, { doc: Doc; score: number }>();
  for (const doc of prep.docs) {
    const page = index.pages[doc.page];
    if (!page || (opts.type !== undefined && page.type !== opts.type)) continue;
    const score = scoreOf(doc, tokens, prep);
    if (score <= 0) continue;
    const kept = best.get(doc.page);
    if (!kept || score > kept.score) best.set(doc.page, { doc, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.doc.page - b.doc.page || a.doc.section - b.doc.section)
    .slice(0, opts.limit)
    .map(({ doc, score }) => {
      const page = index.pages[doc.page] as AgentPage;
      const s = index.sections[doc.section];
      return {
        path: page.path,
        title: page.title,
        heading: s?.heading ?? "",
        anchor: s?.anchor ?? null,
        snippet: snippetOf(textOrChild(index, doc.section)),
        type: page.type,
        // Rounded, so the JSON of a hit is the same on each run and each platform.
        score: Math.round(score * 10_000) / 10_000,
      };
    });
}
