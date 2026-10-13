import { describe, expect, it } from "vitest";
import { checkFrontmatter } from "../scripts/check-frontmatter.ts";

const repo: Record<string, string> = {
  "docs/spec.md": "## 8. Flows\n\n### 8.2 Magic link\n",
  "packages/core/README.md": "# core\n\n## Passwords\n",
};
const read = (p: string) => repo[p] ?? null;
const TEMPLATE =
  "**For:** a developer.\n\n**What it does:** it works.\n\n## Before you start\n\n- A thing.\n\n## Next\n\n- [Home](/docs/)\n";
const HOW_TO = TEMPLATE.replace("## Next", "## If it fails\n\n- Nothing.\n\n## Next");
function page(frontmatter: string, body = TEMPLATE) {
  return { path: "docs/x.md", source: `---\n${frontmatter}\n---\n${body}` };
}
const GOOD =
  'title: X\ndescription: Y.\ntype: reference\nsources:\n  - docs/spec.md 8.2\n  - packages/core/README.md "Passwords"';

describe("checkFrontmatter", () => {
  it("passes a page with the four fields, sources that exist, and the template", () => {
    const r = checkFrontmatter([page(GOOD)], read);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, sources: 2 });
  });

  it("refuses a page with no type, and a type outside the four", () => {
    expect(checkFrontmatter([page(GOOD.replace("type: reference\n", ""))], read).failures).toEqual([
      "docs/x.md: has no type",
    ]);
    expect(checkFrontmatter([page(GOOD.replace("reference", "guide"))], read).failures).toEqual([
      "docs/x.md: type guide is not one of tutorial, how-to, reference, explanation",
    ]);
  });

  it("refuses a source file that does not exist", () => {
    const r = checkFrontmatter([page(GOOD.replace("docs/spec.md 8.2", "docs/gone.md 8.2"))], read);
    expect(r.failures).toEqual(["docs/x.md: source docs/gone.md does not exist"]);
  });

  it("refuses a source heading that the file does not have (plan 11a, Review Focus 3)", () => {
    const r = checkFrontmatter([page(GOOD.replace('"Passwords"', '"Pass words"'))], read);
    expect(r.failures).toEqual([
      "docs/x.md: source packages/core/README.md has no heading Pass words",
    ]);
    const n = checkFrontmatter([page(GOOD.replace("8.2", "8.9"))], read);
    expect(n.failures).toEqual(["docs/x.md: source docs/spec.md has no heading 8.9"]);
  });

  it("refuses a how-to guide with no If it fails part, and a page with no Next part", () => {
    const howTo = GOOD.replace("reference", "how-to");
    expect(checkFrontmatter([page(howTo)], read).failures).toEqual([
      "docs/x.md: lacks the template part ## If it fails",
    ]);
    expect(checkFrontmatter([page(howTo, HOW_TO)], read).failures).toEqual([]);
    expect(
      checkFrontmatter([page(GOOD, TEMPLATE.replace("## Next", "## Then"))], read).failures,
    ).toEqual(["docs/x.md: lacks the template part ## Next"]);
  });

  it("fails when it reads no page", () => {
    expect(checkFrontmatter([], read).failures).toEqual(["read 0 pages", "read 0 sources"]);
  });
});
