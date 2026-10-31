// check-pre-release (review M2 and L7 of plan 12j Task 13b, spec 33 item 7).
// Some texts are true only while no release exists, such as "No release exists
// yet." in SECURITY.md. While core is at 0.0.0, each text of
// PRE_RELEASE_SENTENCES is in its file. Above 0.0.0, none is. So the version
// pull request of the first release removes each one, or this check fails.
// check-security-policy holds the texts of SECURITY.md on release/support.json
// too, so a removed text with no support row also fails. The check also reads
// each docs page and each listed file for PRE_RELEASE_PATTERN. A match outside
// the list fails at every version, so a new text of this kind joins the list.
// A text that stays true after the first release takes an entry of
// PRE_RELEASE_EXEMPT with its reason instead (ruling 58 of plan 12j, item 5).
import type { PreReleaseExempt, PreReleaseSentence } from "../src/data/unpublished.ts";
import type { Page } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The folder of the docs pages, from the repository root. */
const DOCS_DIR = "apps/site/src/content/docs/";

export interface PreReleaseInput {
  /** The version of core: the group version (check-packages holds one version). */
  version: string;
  /** PRE_RELEASE_SENTENCES. */
  listed: readonly PreReleaseSentence[];
  /** A file by its repository path, or null when it does not exist. */
  read: (path: string) => string | null;
  /** Every docs page, by its path under src/content/docs/. */
  pages: readonly Page[];
  /** PRE_RELEASE_PATTERN. */
  pattern: RegExp;
  /** PRE_RELEASE_EXEMPT. */
  exempt: readonly PreReleaseExempt[];
}

/** The line of a text that holds the index, trimmed and cut to 80 characters. */
function lineAt(text: string, index: number): { line: number; excerpt: string } {
  const before = text.slice(0, index);
  const start = before.lastIndexOf("\n") + 1;
  const end = text.indexOf("\n", index);
  const whole = text.slice(start, end === -1 ? undefined : end).trim();
  return {
    line: before.split("\n").length,
    excerpt: whole.length > 80 ? `${whole.slice(0, 80)} …` : whole,
  };
}

export function checkPreRelease(input: PreReleaseInput): CheckReport {
  const { version, listed, read, pages, exempt } = input;
  const r: CheckReport = {
    name: "check-pre-release",
    counts: {
      listed: listed.length,
      files: 0,
      pages: pages.length,
      present: 0,
      exempt: exempt.length,
    },
    failures: [],
  };
  const unreleased = version === "0.0.0";

  // Each file of the list and each docs page, by its repository path.
  const texts = new Map<string, string>();
  for (const p of pages) texts.set(`${DOCS_DIR}${p.path}`, p.source);
  const files = [...new Set(listed.map((e) => e.file))];
  r.counts.files = files.length;
  for (const file of files) {
    const text = texts.get(file) ?? read(file);
    if (text === null) r.failures.push(`PRE_RELEASE_SENTENCES names ${file}, which does not exist`);
    else texts.set(file, text);
  }

  // Each listed text, both ways.
  const seen = new Set<string>();
  for (const { file, sentence } of listed) {
    const key = `${file}\n${sentence}`;
    if (seen.has(key))
      r.failures.push(`PRE_RELEASE_SENTENCES lists twice, in ${file}: ${sentence}`);
    seen.add(key);
    const text = texts.get(file);
    if (text === undefined) continue;
    const holds = text.includes(sentence);
    if (holds) r.counts.present = (r.counts.present ?? 0) + 1;
    if (unreleased && !holds)
      r.failures.push(`${file}: core is at 0.0.0, and the file lacks the text: ${sentence}`);
    if (!unreleased && holds)
      r.failures.push(
        `${file}: core is at ${version}, and the file still holds the text: ${sentence}`,
      );
  }

  // Each exempt text is in its file at every version, with a reason and a match.
  const global = new RegExp(input.pattern.source, `${input.pattern.flags.replace("g", "")}g`);
  const exemptSeen = new Set<string>();
  for (const e of exempt) {
    // An empty text is in each file, so it exempts each match and proves
    // nothing. The span loop below once read it with no end (rr-r57 of plan 12j).
    if (e.text === "") {
      r.failures.push(`PRE_RELEASE_EXEMPT: an entry of ${e.file} has an empty text`);
      continue;
    }
    const key = `${e.file}\n${e.text}`;
    if (exemptSeen.has(key))
      r.failures.push(`PRE_RELEASE_EXEMPT lists twice, in ${e.file}: ${e.text}`);
    exemptSeen.add(key);
    const text = texts.get(e.file) ?? read(e.file);
    if (text !== null) texts.set(e.file, text);
    if (text === null || !text.includes(e.text))
      r.failures.push(`PRE_RELEASE_EXEMPT names ${e.file}, which lacks the text: ${e.text}`);
    if (e.reason.trim() === "")
      r.failures.push(`PRE_RELEASE_EXEMPT: the text of ${e.file} has no reason: ${e.text}`);
    if (listed.some((l) => l.file === e.file && l.sentence === e.text))
      r.failures.push(
        `${e.file}: PRE_RELEASE_SENTENCES and PRE_RELEASE_EXEMPT both list the text: ${e.text}`,
      );
    if ([...e.text.matchAll(global)].length === 0)
      r.failures.push(
        `PRE_RELEASE_EXEMPT: the text of ${e.file} does not hold the pattern, so it needs no entry: ${e.text}`,
      );
  }

  // Each match of the pattern lies inside a listed or an exempt text of its file.
  for (const [file, text] of texts) {
    const spans = [
      ...listed.filter((e) => e.file === file).map((e) => e.sentence),
      ...exempt.filter((e) => e.file === file).map((e) => e.text),
    ]
      // An empty text has no span; its entry fails above.
      .filter((part) => part !== "")
      .flatMap((part) => {
        const out: [number, number][] = [];
        for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + 1))
          out.push([i, i + part.length]);
        return out;
      });
    for (const m of text.matchAll(global)) {
      const at = m.index ?? 0;
      if (spans.some(([from, to]) => at >= from && at + m[0].length <= to)) continue;
      const { line, excerpt } = lineAt(text, at);
      r.failures.push(
        `${file}:${line}: holds "${m[0]}", and PRE_RELEASE_SENTENCES lacks its text: ${excerpt}`,
      );
    }
  }
  return requireCounts(r, ["listed", "pages"]);
}
