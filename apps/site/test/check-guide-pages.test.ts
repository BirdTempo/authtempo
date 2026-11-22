import { GUIDES, type IdpGuide } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { checkFrontmatter } from "../scripts/check-frontmatter.ts";
import { checkGuidePages } from "../scripts/check-guide-pages.ts";
import { FORBIDDEN_TERMS } from "../scripts/check-terms.ts";
import {
  approved,
  GUIDE_PAGE_PREFIX,
  guidePageMarkdown,
  guidePagePath,
  NOT_CHECKED,
} from "../src/data/guide-pages.ts";

// Plan 13a Task 15. One page for each guide of GUIDES, written from the record.
// The check holds each page to the record, and the built page to the page.

const GUIDE: IdpGuide = {
  id: "acme",
  name: "Acme ID",
  kinds: ["saml", "oidc"],
  checkedOn: "2026-11-23",
  fields: {
    acsUrl: "Reply URL",
    entityId: "Entity ID",
    redirectUri: "",
    scimBaseUrl: "Tenant URL",
    scimToken: "Secret",
  },
  steps: [
    { text: 'Go to "Apps > Add".' },
    { text: 'For SAML, enter the ACS URL in "Reply URL".', value: "acsUrl" },
    {
      text: 'For SAML, set "Name ID" to the persistent format.',
      unconfirmed: 'The docs do not list the options of "Name ID".',
    },
  ],
  launch: "Add a bookmark with the URL /sso/<id>/start.",
  launchUnconfirmed: "The docs do not name the page of the bookmark.",
  directory: null,
};

/** The built form of a page: the markdown turned into the tags that matter here. */
function built(md: string): string {
  const body = md.replace(/^---[\s\S]*?---\n/, "");
  const html = body
    .replace(/`([^`]*)`/g, (_m, c: string) => `<code>${c.replace(/</g, "&#x3C;")}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/"/g, "&#x22;");
  return `<html><body><main id="main">${html}</main></body></html>`;
}

function world(guides: readonly IdpGuide[] = [GUIDE]) {
  const sources = new Map<string, string>();
  const pages = new Map<string, string>();
  for (const g of guides) {
    const md = guidePageMarkdown(g);
    sources.set(guidePagePath(g.id), md);
    pages.set(`/${guidePagePath(g.id).replace(/\.md$/, "")}/`, built(md));
  }
  return { sources, pages };
}
const run = (
  w: ReturnType<typeof world>,
  guides: readonly IdpGuide[] = [GUIDE],
  extra: string[] = [],
) =>
  checkGuidePages({
    guides,
    sources: w.sources,
    built: (url) => w.pages.get(url) ?? "",
    extra,
  });

describe("guidePageMarkdown", () => {
  const md = guidePageMarkdown(GUIDE);

  it("names the date, the steps, and each unconfirmed mark with its words", () => {
    expect(md).toContain("2026-11-23");
    expect(md).toContain(NOT_CHECKED);
    expect(md).toContain('1. Go to "Apps > Add".');
    expect(md).toContain('**Unconfirmed:** The docs do not list the options of "Name ID".');
    expect(md).toContain("**Unconfirmed:** The docs do not name the page of the bookmark.");
  });

  it("puts each angle bracket of a guide text in a code span", () => {
    expect(md).toContain("`/sso/<id>/start`");
    // A `>` inside a sentence is plain text in markdown. A `<` opens a tag, so it must sit in a code span.
    expect(md.replace(/`[^`]*`/g, "")).not.toContain("<");
  });

  it("holds the template of a how-to page, with a source that exists", () => {
    const page = { path: guidePagePath("acme"), source: md };
    const files = new Set([
      "packages/core/src/sso/guides/acme.ts",
      "packages/core/src/sso/guides/index.ts",
    ]);
    const r = checkFrontmatter([page], (p) => (files.has(p) ? "x" : null));
    expect(r.failures).toEqual([]);
  });

  it("says that the provider sends no SCIM when the record has no directory text", () => {
    expect(md).toContain("sends no SCIM");
  });

  it("names the page of each real guide by its id", () => {
    expect(GUIDES.map((g) => guidePagePath(g.id))).toEqual(
      GUIDES.map((g) => `docs/guides/${GUIDE_PAGE_PREFIX}${g.id}.md`),
    );
  });
});

describe("approved", () => {
  it("writes the approved term for a forbidden term outside a double-quoted name", () => {
    expect(approved("Create an app in your IdP. Copy the IDP metadata.")).toBe(
      "Create an app in your provider. Copy the provider metadata.",
    );
    expect(approved("An IdP-initiated sign-in. Many IdPs do.")).toBe(
      "A provider-initiated sign-in. Many providers do.",
    );
    expect(approved("Set the login initiation endpoint.")).toBe(
      "Set the sign-in initiation endpoint.",
    );
  });

  it("keeps a double-quoted label as the provider writes it", () => {
    expect(approved('Open "IdP login" in the IdP.')).toBe('Open "IdP login" in the provider.');
  });

  it("leaves no forbidden term in the page of a real guide, outside a code span or a quoted name", () => {
    for (const g of GUIDES) {
      const prose = guidePageMarkdown(g)
        .replace(/^---[\s\S]*?---\n/, "")
        .replace(/`[^`]*`/g, "")
        .replace(/"[^"]*"/g, "");
      for (const { term, pattern } of FORBIDDEN_TERMS)
        expect(prose, `${g.id}: ${term}`).not.toMatch(pattern);
    }
  });
});

describe("checkGuidePages", () => {
  it("passes when each page equals its record and the built page shows the date and each mark", () => {
    const r = run(world());
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ guides: 1, pages: 1, marks: 2 });
  });

  it("passes the five real guides", () => {
    const r = run(world(GUIDES), GUIDES);
    expect(r.failures).toEqual([]);
    expect(r.counts.guides).toBe(5);
    expect(r.counts.marks).toBe(
      GUIDES.reduce(
        (n, g) => n + g.steps.filter((s) => s.unconfirmed).length + (g.launchUnconfirmed ? 1 : 0),
        0,
      ),
    );
  });

  it("refuses a guide with no page", () => {
    const w = world();
    w.sources.clear();
    // The empty count fails too: a check that reads no page must not pass.
    expect(run(w).failures).toEqual([`${guidePagePath("acme")} is missing`, "read 0 pages"]);
  });

  it("refuses a page that differs from its record", () => {
    const w = world();
    w.sources.set(guidePagePath("acme"), `${guidePageMarkdown(GUIDE)}\nAn edit by hand.\n`);
    expect(run(w).failures).toEqual([
      `${guidePagePath("acme")} differs from GUIDES; run node scripts/write-guide-pages.ts`,
    ]);
  });

  it("refuses a built page that lacks the date, a step, or a mark", () => {
    for (const cut of ["2026-11-23", "Go to", "The docs do not name the page of the bookmark."]) {
      const w = world();
      const url = `/${guidePagePath("acme").replace(/\.md$/, "")}/`;
      w.pages.set(url, (w.pages.get(url) ?? "").replaceAll(cut, "x"));
      const r = run(w);
      expect(r.failures.length, cut).toBeGreaterThan(0);
    }
  });

  it("refuses a built page whose mark count differs from the record", () => {
    const w = world();
    const url = `/${guidePagePath("acme").replace(/\.md$/, "")}/`;
    w.pages.set(
      url,
      (w.pages.get(url) ?? "").replace("<strong>Unconfirmed:</strong>", "<b>Maybe:</b>"),
    );
    expect(run(w).failures).toEqual([`${url} shows 1 Unconfirmed marks; the record has 2`]);
  });

  it("refuses a page that does not say the label was not checked on a real tenant", () => {
    const w = world();
    const url = `/${guidePagePath("acme").replace(/\.md$/, "")}/`;
    w.pages.set(url, (w.pages.get(url) ?? "").replace(NOT_CHECKED, "Checked."));
    expect(run(w).failures).toEqual([`${url} lacks the sentence: ${NOT_CHECKED}`]);
  });

  it("refuses a page of the guide folder that no guide owns", () => {
    const w = world();
    w.sources.set(`docs/guides/${GUIDE_PAGE_PREFIX}gone.md`, "x");
    expect(run(w).failures).toEqual([
      `docs/guides/${GUIDE_PAGE_PREFIX}gone.md has no guide in GUIDES`,
    ]);
  });

  it("refuses a price on a new page (spec section 9: no price of another product)", () => {
    const w = world();
    const url = `/${guidePagePath("acme").replace(/\.md$/, "")}/`;
    w.pages.set(
      url,
      (w.pages.get(url) ?? "").replace("</main>", "<p>It costs $25 a month.</p></main>"),
    );
    expect(run(w).failures[0]).toContain("names a price");
    const extra = "/docs/guides/sso-setup-link/";
    w.pages.set(extra, '<main id="main"><p>Costs $9 per user.</p></main>');
    expect(run(w, [GUIDE], [extra]).failures.some((f) => f.startsWith(extra))).toBe(true);
  });

  it("refuses an extra page that the build did not write", () => {
    const w = world();
    expect(run(w, [GUIDE], ["/docs/guides/sso-setup-link/"]).failures).toEqual([
      "/docs/guides/sso-setup-link/ is not built",
    ]);
  });
});
