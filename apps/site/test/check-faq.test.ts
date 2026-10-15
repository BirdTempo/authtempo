import { describe, expect, it } from "vitest";
import { checkFaq, FAQ_PAGE, migrationGuides } from "../scripts/check-faq.ts";
import { docsPages } from "../scripts/lib/load.ts";

const guides = ["/docs/migrate/a/", "/docs/migrate/b/"];

/** A page of `n` entries; each answer links guide a or guide b in turn. */
function page(n: number): string {
  const entries = Array.from({ length: n }, (_, i) => {
    const guide = guides[i % guides.length] ?? "";
    return `### Question ${i}?\n\nAn answer. See [the guide](${guide}#how-it-behaves).\n`;
  });
  return `---\ntitle: FAQ\n---\n\n## Questions\n\n${entries.join("\n")}\n## Next\n\n- [A](/docs/migrate/a/)\n`;
}

describe("checkFaq", () => {
  it("passes on the real page and the real guides", () => {
    const pages = docsPages();
    const faq = pages.find((p) => p.path === FAQ_PAGE)?.source ?? "";
    const real = migrationGuides(pages);
    const r = checkFaq(faq, real);
    expect(r.failures).toEqual([]);
    expect(r.counts.guides).toBe(8);
    expect(r.counts.entries).toBeGreaterThanOrEqual(8);
  });

  it("fails on a guide that no answer links", () => {
    const r = checkFaq(page(8), [...guides, "/docs/migrate/c/"]);
    expect(r.failures).toEqual(["no answer links the guide /docs/migrate/c/"]);
  });

  it("fails on an answer with no link", () => {
    const source = page(8).replace("See [the guide](/docs/migrate/a/#how-it-behaves).", "");
    const r = checkFaq(source, guides);
    expect(r.failures).toEqual(['the answer of "Question 0?" has no link']);
  });

  it("fails at fewer than 8 entries, and on a question with no question mark", () => {
    expect(checkFaq(page(7), guides).failures).toEqual(["7 entries; the page needs at least 8"]);
    const r = checkFaq(page(8).replace("### Question 1?", "### Question 1"), guides);
    expect(r.failures).toEqual(['the question "Question 1" does not end with ?']);
  });
});
