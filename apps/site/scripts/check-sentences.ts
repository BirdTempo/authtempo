import {
  type Page,
  parseFrontmatter,
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
 * Every sentence of prose. A sentence that cannot meet the limit is exempt by
 * its markup only: a table cell, a heading, a code span (one word), or a
 * fence. No list of page names exempts anything.
 */
export function checkSentences(pages: readonly Page[]): CheckReport {
  const r: CheckReport = {
    name: "check-sentences",
    counts: { pages: pages.length, sentences: 0 },
    failures: [],
  };
  for (const p of pages) {
    const fm = parseFrontmatter(p.source);
    if (!fm) continue;
    for (const unit of proseUnits(fm.body, fm.bodyLine)) {
      const max = unit.kind === "step" ? STEP_MAX : TEXT_MAX;
      for (const s of sentences(plainText(unit.text))) {
        r.counts.sentences = (r.counts.sentences ?? 0) + 1;
        const n = wordCount(s);
        if (n > max) {
          const start = s.split(/\s+/).slice(0, 8).join(" ");
          const kind = unit.kind === "step" ? "numbered step" : "sentence";
          r.failures.push(
            `${p.path}:${unit.line}: ${n} words in a ${kind} (at most ${max}): "${start} …"`,
          );
        }
      }
    }
  }
  return requireCounts(r, ["pages", "sentences"]);
}
