import {
  type Page,
  pageBody,
  plainText,
  proseUnits,
  sentences,
  wordCount,
} from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** ASD-STE100: at most 20 words in a procedure sentence and 25 in a description. */
export const STEP_MAX = 20;
export const TEXT_MAX = 25;

/**
 * A cell sentence whose words are all code spans, joined by commas, "and", or
 * "or". It is a list, such as the route links of an errors cell, and not a
 * sentence (decision 5 of plan 12n). plainText gives each code span as CODE.
 */
const CODE_LIST = /^CODE(?:(?:,|,? and|,? or) CODE)*[.;:]?$/;

/**
 * Every sentence of prose. A sentence that cannot meet the limit is exempt by
 * its markup only: a heading, a code span (one word), or a fence. A table cell
 * is a description, so each sentence of a cell has the limit of a description.
 * The header row is exempt, and so is a list of code spans in a cell. No list of
 * page names exempts anything.
 */
export function checkSentences(pages: readonly Page[]): CheckReport {
  const r: CheckReport = {
    name: "check-sentences",
    counts: { pages: pages.length, sentences: 0, lists: 0 },
    failures: [],
    exempt: [],
  };
  for (const p of pages) {
    const fm = pageBody(p);
    if (!fm) continue;
    for (const unit of proseUnits(fm.body, fm.bodyLine, { cells: true })) {
      const max = unit.kind === "step" ? STEP_MAX : TEXT_MAX;
      for (const s of sentences(plainText(unit.text))) {
        r.counts.sentences = (r.counts.sentences ?? 0) + 1;
        const n = wordCount(s);
        if (n <= max) continue;
        if (unit.kind === "cell" && CODE_LIST.test(s)) {
          r.counts.lists = (r.counts.lists ?? 0) + 1;
          const spans = s.match(/CODE/g)?.length ?? 0;
          r.exempt?.push(`${p.path}:${unit.line}: a list of ${spans} code spans in a table cell`);
          continue;
        }
        const start = s.split(/\s+/).slice(0, 8).join(" ");
        const kind =
          unit.kind === "step" ? "numbered step" : unit.kind === "cell" ? "table cell" : "sentence";
        r.failures.push(
          `${p.path}:${unit.line}: ${n} words in a ${kind} (at most ${max}): "${start} …"`,
        );
      }
    }
  }
  return requireCounts(r, ["pages", "sentences"]);
}
