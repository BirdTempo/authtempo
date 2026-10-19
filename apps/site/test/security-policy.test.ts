import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { prosePages } from "../scripts/lib/prose.ts";
import { POLICY_PROSE_PATH, policyProsePages } from "../scripts/lib/root-prose.ts";
import { renderPolicy } from "../src/data/security.ts";

// A SECURITY.md in the usual form: an h1, a paragraph, two h2, a list, and a
// link. Plan 12j writes the real file; /security/ shows it (ruling 21).
const FIXTURE = readFileSync(`${SITE}test/fixtures/site/security/SECURITY.md`, "utf8");

describe("SECURITY.md on /security/ (plan 11b)", () => {
  it("renders the file with each heading two levels down, so it adds no h1 and no h2", async () => {
    const html = await renderPolicy(FIXTURE);
    expect(html.match(/<h[12]\b/g)).toBeNull();
    expect(html.match(/<h3\b[^>]*>Security policy<\/h3>/g)?.length).toBe(1);
    expect(html.match(/<h4\b[^>]*>[^<]*<\/h4>/g)?.map((h) => h.replace(/<[^>]+>/g, ""))).toEqual([
      "Supported versions",
      "Contact",
    ]);
    expect(html).toContain("<li>The last release gets each fix.</li>");
    expect(html).toContain('<a href="mailto:security@example.com">the security address</a>');
    expect(html).toContain("Report a fault to the owner by mail.");
  });

  it("goes no lower than h6", async () => {
    expect(await renderPolicy("##### Five\n\n###### Six\n")).toMatch(
      /^<h6\b[^>]*>Five<\/h6>\s*<h6\b[^>]*>Six<\/h6>$/,
    );
  });

  it("reads the file in the prose list when it exists, and no page when it is absent", () => {
    expect(policyProsePages(null)).toEqual([]);
    const pages = prosePages(undefined, FIXTURE).filter((p) => p.path === POLICY_PROSE_PATH);
    expect(pages.length).toBe(1);
    expect(checkSentences(pages).failures).toEqual([]);
  });

  it("names SECURITY.md and its line in a term failure", () => {
    const broken = policyProsePages(`${FIXTURE}\nLog in to the portal to see a report.\n`);
    // checkTerms also asks for the glossary page, which this list does not hold.
    expect(checkTerms(broken).failures.filter((f) => f.startsWith("SECURITY.md"))).toEqual([
      `${POLICY_PROSE_PATH}:14: "Log in" is forbidden; write "sign in"`,
    ]);
  });
});
