import { describe, expect, it } from "vitest";
import { checkFrontmatter, pageUrl } from "../scripts/check-frontmatter.ts";

const repo: Record<string, string> = {
  "docs/spec.md": "## 8. Flows\n\n### 8.2 Magic link\n",
  "packages/core/README.md": "# core\n\n## Passwords\n",
};
const read = (p: string) => repo[p] ?? null;
const TEMPLATE =
  "**For:** a developer.\n\n**What it does:** it works.\n\n## Before you start\n\n- A [thing](/docs/).\n\n## Next\n\n- [Home](/docs/)\n";
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
    expect(r.counts).toEqual({ pages: 1, sources: 2, prerequisites: 1, exempt: 0 });
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

  it("does not take Task 3 for Task 30 in a quoted heading", () => {
    const longer: Record<string, string> = { ...repo, "docs/plan.md": "### Task 30\n" };
    const src = GOOD.replace("docs/spec.md 8.2", 'docs/plan.md "Task 3"');
    expect(checkFrontmatter([page(src)], (p) => longer[p] ?? null).failures).toEqual([
      "docs/x.md: source docs/plan.md has no heading Task 3",
    ]);
    expect(
      checkFrontmatter(
        [page(src)],
        (p) => ({ ...longer, "docs/plan.md": "### Task 3: x\n" })[p] ?? null,
      ).failures,
    ).toEqual([]);
  });

  it("refuses template parts out of order", () => {
    const swapped = TEMPLATE.replace(
      "## Before you start\n\n- A [thing](/docs/).\n\n## Next\n\n- [Home](/docs/)\n",
      "## Next\n\n- [Home](/docs/)\n\n## Before you start\n\n- A [thing](/docs/).\n",
    );
    expect(checkFrontmatter([page(GOOD, swapped)], read).failures).toEqual([
      "docs/x.md: the template part ## Next is out of order",
    ]);
  });

  it("refuses a Next part with no link or with more than three (spec 18.3)", () => {
    const next = (items: string) =>
      checkFrontmatter([page(GOOD, TEMPLATE.replace("- [Home](/docs/)\n", items))], read).failures;
    expect(next("- Nothing.\n")).toEqual(["docs/x.md: Next holds 0 links (1 to 3)"]);
    const four = "- [A](/docs/a/)\n- [B](/docs/b/)\n- [C](/docs/c/)\n- [D](/docs/d/)\n";
    expect(next(four)).toEqual(["docs/x.md: Next holds 4 links (1 to 3)"]);
    expect(next("- [A](/docs/a/)\n- [B](/docs/b/)\n- [C](/docs/c/)\n")).toEqual([]);
  });

  it("refuses a Before you start item with no link, unless it names a tool or an account", () => {
    const prereq = (items: string) =>
      checkFrontmatter([page(GOOD, TEMPLATE.replace("- A [thing](/docs/).\n", items))], read);
    expect(prereq("- A database.\n").failures).toEqual([
      'docs/x.md: the Before you start item "A database." has no link and names no tool or account',
    ]);
    const tools = prereq("- Node 22.18 or newer.\n- A Cloudflare account.\n");
    expect(tools.failures).toEqual([]);
    expect(tools.counts.exempt).toBe(2);
    expect(tools.exempt).toEqual([
      "docs/x.md: Node 22.18 or newer.",
      "docs/x.md: A Cloudflare account.",
    ]);
    expect(prereq("- Dockerfile of the app.\n").failures).toHaveLength(1);
    expect(prereq("- A database,\n  as [Schema](/docs/schema/) tells.\n").failures).toEqual([]);
  });

  it("refuses a Before you start link to the page itself, with or without an anchor", () => {
    const prereq = (items: string) =>
      checkFrontmatter([page(GOOD, TEMPLATE.replace("- A [thing](/docs/).\n", items))], read)
        .failures;
    expect(prereq("- A [thing](/docs/x/).\n")).toEqual([
      "docs/x.md: the Before you start item links /docs/x/, the page itself",
    ]);
    expect(prereq("- A [thing](/docs/x/#steps).\n")).toEqual([
      "docs/x.md: the Before you start item links /docs/x/#steps, the page itself",
    ]);
    expect(prereq("- A [thing](#steps).\n")).toEqual([
      "docs/x.md: the Before you start item links #steps, the page itself",
    ]);
    expect(prereq("- A [thing](/docs/xy/#steps).\n")).toEqual([]);
  });

  it("maps a page path to its URL", () => {
    expect(pageUrl("docs/migrate/cutover.md")).toBe("/docs/migrate/cutover/");
    expect(pageUrl("docs/migrate/index.md")).toBe("/docs/migrate/");
    expect(pageUrl("docs/index.mdx")).toBe("/docs/");
  });

  it("fails when it reads no page", () => {
    expect(checkFrontmatter([], read).failures).toEqual([
      "read 0 pages",
      "read 0 sources",
      "read 0 prerequisites",
    ]);
  });
});
