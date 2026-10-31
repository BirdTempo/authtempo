// check-unpublished (plan 12j Task 13, deviation 6, spec 33 item 11). The
// note "not on a registry yet" is page text. While core is at 0.0.0, each page
// of UNPUBLISHED_PAGES holds it, and no other docs page does. Above 0.0.0, no
// docs page holds it, and each listed page holds REGISTRY_INSTALL. So the
// release branch cannot ship a stale note, and it cannot drop a note with no
// install text in its place. A page holds the note when noteForms finds a
// form of UNPUBLISHED_FORMS in it, with no regard to case or to a line break.
// check-pack and rewrite-unpublished read the same list (ruling 58 of plan
// 12j, item 3), so a page note in another form cannot pass this check.
import { noteForms } from "../src/data/unpublished.ts";
import type { Page } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

export interface UnpublishedInput {
  /** The version of core: the group version (check-packages holds one version). */
  version: string;
  /** Every docs page, by its path under src/content/docs/. */
  pages: readonly Page[];
  /** UNPUBLISHED_PAGES. */
  listed: readonly string[];
  install: string;
}

/** The forms of a failure line, each in quotes. */
const quoted = (forms: readonly string[]) => forms.map((f) => `"${f}"`).join(", ");

export function checkUnpublished(input: UnpublishedInput): CheckReport {
  const { version, pages, listed, install } = input;
  const r: CheckReport = {
    name: "check-unpublished",
    counts: { pages: pages.length, listed: listed.length, marked: 0 },
    failures: [],
  };
  const byPath = new Map(pages.map((p) => [p.path, p.source]));
  const seen = new Set<string>();
  for (const path of listed) {
    if (seen.has(path)) r.failures.push(`UNPUBLISHED_PAGES lists ${path} twice`);
    seen.add(path);
    if (!byPath.has(path)) r.failures.push(`UNPUBLISHED_PAGES lists ${path}, which is not a page`);
  }
  const unreleased = version === "0.0.0";
  for (const p of pages) {
    const forms = noteForms(p.source);
    const holds = forms.length > 0;
    if (holds) r.counts.marked = (r.counts.marked ?? 0) + 1;
    if (unreleased) {
      if (seen.has(p.path) && !holds)
        r.failures.push(
          `${p.path}: core is at 0.0.0, and the page holds no form of UNPUBLISHED_FORMS`,
        );
      if (!seen.has(p.path) && holds)
        r.failures.push(
          `${p.path}: holds the note ${quoted(forms)}, and UNPUBLISHED_PAGES lacks it`,
        );
    } else {
      if (holds)
        r.failures.push(
          `${p.path}: core is at ${version}, and the page still holds ${quoted(forms)}`,
        );
      if (seen.has(p.path) && !p.source.includes(install))
        r.failures.push(`${p.path}: core is at ${version}, and the page lacks REGISTRY_INSTALL`);
    }
  }
  return requireCounts(r, ["pages", "listed"]);
}
