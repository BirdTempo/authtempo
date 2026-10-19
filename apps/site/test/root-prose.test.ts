import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { parseFrontmatter } from "../scripts/lib/markdown.ts";
import { prosePages } from "../scripts/lib/prose.ts";
import { ROOT_PROSE_PATH, rootProsePage } from "../scripts/lib/root-prose.ts";
import { licenseLine, PLATFORM_COSTS, PRICING_PAGE } from "../src/data/costs.ts";
import { rootLicense } from "../src/data/repo.ts";
import { SECURITY_PAGE } from "../src/data/security.ts";

describe("the prose of /pricing/ and /security/ (plan 11b)", () => {
  it("puts each string of the page data in the prose page as its own paragraph", () => {
    const body = parseFrontmatter(rootProsePage().source)?.body ?? "";
    const paragraphs = body
      .split("\n\n")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    expect(paragraphs.sort()).toEqual(
      [
        ...Object.values(PRICING_PAGE),
        ...PLATFORM_COSTS.map((c) => c.fact),
        licenseLine(rootLicense()),
        ...Object.values(SECURITY_PAGE),
      ].sort(),
    );
  });

  it("is one page of the list that check-terms and check-sentences read", () => {
    expect(prosePages().filter((p) => p.path === ROOT_PROSE_PATH).length).toBe(1);
    expect(checkSentences([rootProsePage()]).failures).toEqual([]);
  });

  it("names the prose page in a term failure", () => {
    const page = rootProsePage();
    const broken = { ...page, source: `${page.source}\nLog in with one click.\n` };
    expect(checkTerms([broken]).failures.some((f) => f.startsWith(ROOT_PROSE_PATH))).toBe(true);
  });

  it("states the license line, or the empty state of the footer as a sentence", () => {
    expect(licenseLine(null)).toBe("The license is not set yet.");
    expect(licenseLine("MIT")).toBe("The license is MIT.");
  });
});
