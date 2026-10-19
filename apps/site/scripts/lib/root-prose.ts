import { licenseLine, PLATFORM_COSTS, PRICING_PAGE } from "../../src/data/costs.ts";
import { readRepoText, rootLicense } from "../../src/data/repo.ts";
import { SECURITY_PAGE } from "../../src/data/security.ts";
import type { Page } from "./markdown.ts";

/** The path that a failure of check-terms or check-sentences names for this prose. */
export const ROOT_PROSE_PATH =
  "site/pricing and site/security (src/data/costs.ts, src/data/security.ts)";

/**
 * The prose of /pricing/ and /security/ that is not in their entries, one
 * paragraph each. It holds the labels, each platform cost, the license line,
 * and the empty state of the reporting channel. A quote is a docs sentence,
 * which the checks read on its own page.
 */
export function rootProsePage(): Page {
  const paragraphs = [
    ...Object.values(PRICING_PAGE),
    ...PLATFORM_COSTS.map((c) => c.fact),
    licenseLine(rootLicense()),
    ...Object.values(SECURITY_PAGE),
  ];
  return {
    path: ROOT_PROSE_PATH,
    source: `---\ntitle: ${PRICING_PAGE.cost}\ndescription: ${PRICING_PAGE.source}\n---\n\n${paragraphs.join("\n\n")}\n`,
  };
}

/** The path that a failure names for SECURITY.md: a plain page, so each line number is real. */
export const POLICY_PROSE_PATH = "SECURITY.md";

/**
 * SECURITY.md of the repository root as a prose page, or no page while the
 * file is absent. /security/ shows the file, so check-terms and
 * check-sentences read it (ruling 21 of the plan 11b lane).
 */
export function policyProsePages(text: string | null = readRepoText("SECURITY.md")): Page[] {
  return text === null ? [] : [{ path: POLICY_PROSE_PATH, source: text, plain: true }];
}
