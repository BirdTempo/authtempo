import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { DEMO_PROSE_PATH, demoProsePage } from "../scripts/lib/demo-prose.ts";
import { parseFrontmatter } from "../scripts/lib/markdown.ts";
import { prosePages } from "../scripts/lib/prose.ts";
import { ROOT_PROSE_PATH, rootProsePage } from "../scripts/lib/root-prose.ts";
import { licenseLine, PLATFORM_COSTS, PRICING_PAGE } from "../src/data/costs.ts";
import { DEMO_OFF, DEMO_PAGE, limitRows } from "../src/data/demo.ts";
import { licenseOf, rootLicense } from "../src/data/repo.ts";
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

  it("reads a license only from a string that is not blank", () => {
    expect(licenseOf("{}")).toBeNull();
    expect(licenseOf('{"license": ""}')).toBeNull();
    expect(licenseOf('{"license": "  "}')).toBeNull();
    expect(licenseOf('{"license": 5}')).toBeNull();
    expect(licenseOf('{"license": {"type": "MIT"}}')).toBeNull();
    expect(licenseOf('{"license": "MIT"}')).toBe("MIT");
  });

  it("states the license line, or the empty state of the footer as a sentence", () => {
    expect(licenseLine(null)).toBe("The license is not set yet.");
    expect(licenseLine("MIT")).toBe("The license is MIT.");
  });
});

describe("the prose of /demo/ (plan 11b Task 12)", () => {
  it("puts each reason, each part turned off, each limit, and the end lines in the prose page", () => {
    const body = parseFrontmatter(demoProsePage().source)?.body ?? "";
    const paragraphs = body.split("\n\n").map((p) => p.trim());
    for (const text of [
      ...DEMO_OFF.flatMap((x) => [x.name, x.reason]),
      ...limitRows().map((r) => r.text),
      DEMO_PAGE.notOpen,
      DEMO_PAGE.thenOpen,
      DEMO_PAGE.certificate,
      DEMO_PAGE.open,
      "It needs a native or desktop app on the visitor's device.",
    ])
      expect({ text, found: paragraphs.includes(text) }).toEqual({ text, found: true });
  });

  it("is one page of the list that check-terms and check-sentences read", () => {
    expect(prosePages().filter((p) => p.path === DEMO_PROSE_PATH).length).toBe(1);
    expect(checkSentences([demoProsePage()]).failures).toEqual([]);
  });
});
