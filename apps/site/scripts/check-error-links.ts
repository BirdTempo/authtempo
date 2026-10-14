import { DOCS_ORIGIN, ERROR_TEXT, type ErrorTable, errorDocsURL } from "@authtempo/client";
import { TEXT_MAX } from "./check-sentences.ts";
import { FORBIDDEN_TERMS } from "./check-terms.ts";
import { idsOf } from "./lib/html.ts";
import { sentences, wordCount } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** One code of the client's tables, its docs link, and its text. */
export interface ErrorLink {
  table: ErrorTable | "sdk";
  code: string;
  url: string;
  text: string;
}

/** Every code of the client's text tables with the URL that `errorDocsURL` gives it. */
export function errorLinks(): ErrorLink[] {
  const out: ErrorLink[] = [];
  for (const [code, text] of Object.entries(ERROR_TEXT.core))
    out.push({ table: "core", code, url: errorDocsURL(code as never), text });
  for (const [code, text] of Object.entries(ERROR_TEXT.oauth))
    out.push({ table: "oauth", code, url: errorDocsURL(code as never, "oauth"), text });
  for (const [code, text] of Object.entries(ERROR_TEXT.sdk))
    out.push({ table: "sdk", code, url: errorDocsURL(code as never), text });
  return out;
}

/**
 * Every docs link of the client lands on an anchor of a built page, and every
 * error text keeps the glossary and the sentence limit of the docs (plan 11d).
 * An app shows these texts to a person, so they follow the rules of the pages.
 */
export function checkErrorLinks(
  links: readonly ErrorLink[],
  read: (urlPath: string) => string,
): CheckReport {
  const r: CheckReport = {
    name: "check-error-links",
    counts: { links: links.length, anchors: 0, texts: 0 },
    failures: [],
  };
  for (const l of links) {
    const name = `${l.table} code ${l.code}`;
    if (!l.url.startsWith(`${DOCS_ORIGIN}/`))
      r.failures.push(`${name} links ${l.url}, not a page of ${DOCS_ORIGIN}`);
    else {
      const [path = "", anchor] = l.url.slice(DOCS_ORIGIN.length).split("#");
      if (anchor === undefined || anchor === "")
        r.failures.push(`${name} links ${l.url} with no anchor`);
      else if (idsOf(read(path)).has(anchor)) r.counts.anchors = (r.counts.anchors ?? 0) + 1;
      else r.failures.push(`${name} links ${path}#${anchor}, which the build does not have`);
    }
    r.counts.texts = (r.counts.texts ?? 0) + 1;
    for (const t of FORBIDDEN_TERMS)
      if (t.pattern.test(l.text))
        r.failures.push(`${name}: the text uses "${t.term}"; use "${t.use}"`);
    for (const s of sentences(l.text)) {
      const n = wordCount(s);
      if (n > TEXT_MAX)
        r.failures.push(`${name}: the text has a sentence of ${n} words (at most ${TEXT_MAX})`);
    }
  }
  return requireCounts(r, ["links", "anchors", "texts"]);
}
