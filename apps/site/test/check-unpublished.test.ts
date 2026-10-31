import { describe, expect, it } from "vitest";
import { checkUnpublished, type UnpublishedInput } from "../scripts/check-unpublished.ts";
import { docsPages, readRepoFile } from "../scripts/lib/load.ts";
import { summaryLine } from "../scripts/lib/report.ts";
import {
  REGISTRY_INSTALL,
  UNPUBLISHED_FORMS,
  UNPUBLISHED_MARK,
  UNPUBLISHED_PAGES,
} from "../src/data/unpublished.ts";

const NOTE = `The packages are ${UNPUBLISHED_MARK}. Run the command from the repo.`;
const page = (path: string, text: string) => ({ path, source: `---\ntitle: x\n---\n\n${text}\n` });

/** Two listed pages with the note and one page without it, at 0.0.0. */
const BASE: UnpublishedInput = {
  version: "0.0.0",
  pages: [page("docs/a.md", NOTE), page("docs/b.mdx", NOTE), page("docs/c.md", "Other text.")],
  listed: ["docs/a.md", "docs/b.mdx"],
  install: REGISTRY_INSTALL,
};

const failures = (input: UnpublishedInput) => checkUnpublished(input).failures;

describe("check-unpublished", () => {
  it("passes each listed page with the mark at 0.0.0", () => {
    expect(failures(BASE)).toEqual([]);
    expect(summaryLine(checkUnpublished(BASE))).toBe(
      "check-unpublished: PASS pages=3 listed=2 marked=2 failures=0",
    );
  });

  it("fails a listed page with no mark at 0.0.0", () => {
    const pages = [page("docs/a.md", "No note."), ...BASE.pages.slice(1)];
    expect(failures({ ...BASE, pages })).toEqual([
      "docs/a.md: core is at 0.0.0, and the page holds no form of UNPUBLISHED_FORMS",
    ]);
  });

  it("fails any page with the mark above 0.0.0", () => {
    const pages = [page("docs/a.md", REGISTRY_INSTALL), page("docs/b.mdx", NOTE)];
    expect(failures({ ...BASE, version: "0.1.0", pages })).toEqual([
      `docs/b.mdx: core is at 0.1.0, and the page still holds "${UNPUBLISHED_MARK}"`,
      "docs/b.mdx: core is at 0.1.0, and the page lacks REGISTRY_INSTALL",
    ]);
  });

  it("passes above 0.0.0 when each listed page holds the install text and none holds the mark", () => {
    const pages = [page("docs/a.md", REGISTRY_INSTALL), page("docs/b.mdx", REGISTRY_INSTALL)];
    expect(failures({ ...BASE, version: "0.1.0", pages })).toEqual([]);
  });

  it("fails a page with the mark that the list lacks", () => {
    const pages = [...BASE.pages, page("docs/d.md", NOTE)];
    expect(failures({ ...BASE, pages })).toEqual([
      `docs/d.md: holds the note "${UNPUBLISHED_MARK}", and UNPUBLISHED_PAGES lacks it`,
    ]);
  });

  it("matches the mark with no regard to case", () => {
    const upper = "Not on a registry yet: the CLI.";
    expect(failures({ ...BASE, pages: [...BASE.pages, page("docs/d.md", upper)] })).toEqual([
      `docs/d.md: holds the note "${UNPUBLISHED_MARK}", and UNPUBLISHED_PAGES lacks it`,
    ]);
    const pages = [
      page("docs/a.md", REGISTRY_INSTALL),
      page("docs/b.mdx", `${REGISTRY_INSTALL} ${upper}`),
    ];
    expect(failures({ ...BASE, version: "0.1.0", pages })).toEqual([
      `docs/b.mdx: core is at 0.1.0, and the page still holds "${UNPUBLISHED_MARK}"`,
    ]);
  });

  // Ruling 58 of plan 12j, item 3: the one list of check-pack and rewrite-unpublished.
  it("reads each form of UNPUBLISHED_FORMS, not only the first, one probe per form", () => {
    expect(UNPUBLISHED_FORMS.length).toBeGreaterThan(1);
    for (const form of UNPUBLISHED_FORMS) {
      const text = `Text. ${form.charAt(0).toUpperCase()}${form.slice(1).replace(" ", "\n")}, so read on.`;
      // A listed page with only this form holds the note at 0.0.0.
      const pages = [page("docs/a.md", text), ...BASE.pages.slice(1)];
      expect(failures({ ...BASE, pages }), form).toEqual([]);
      // A page that the list lacks fails at 0.0.0.
      expect(failures({ ...BASE, pages: [...BASE.pages, page("docs/d.md", text)] }), form).toEqual([
        `docs/d.md: holds the note "${form}", and UNPUBLISHED_PAGES lacks it`,
      ]);
      // A page that still holds it fails above 0.0.0.
      const after = [
        page("docs/a.md", REGISTRY_INSTALL),
        page("docs/b.mdx", `${REGISTRY_INSTALL} ${text}`),
      ];
      expect(failures({ ...BASE, version: "0.1.0", pages: after }), form).toEqual([
        `docs/b.mdx: core is at 0.1.0, and the page still holds "${form}"`,
      ]);
    }
  });

  it("names each form that a page holds", () => {
    const both = `${NOTE} Until the packages are on a registry, wait.`;
    expect(failures({ ...BASE, pages: [...BASE.pages, page("docs/d.md", both)] })).toEqual([
      `docs/d.md: holds the note "${UNPUBLISHED_MARK}", "until the packages are on a registry", and UNPUBLISHED_PAGES lacks it`,
    ]);
  });

  it("fails a listed path that is not a page, and a path listed twice", () => {
    expect(failures({ ...BASE, listed: [...BASE.listed, "docs/a.md", "docs/gone.md"] })).toEqual([
      "UNPUBLISHED_PAGES lists docs/a.md twice",
      "UNPUBLISHED_PAGES lists docs/gone.md, which is not a page",
    ]);
  });

  it("fails when it reads zero pages", () => {
    expect(failures({ ...BASE, pages: [], listed: [] })).toEqual(["read 0 pages", "read 0 listed"]);
  });

  it("holds the real docs tree to UNPUBLISHED_PAGES", () => {
    const core = JSON.parse(readRepoFile("packages/core/package.json") ?? "{}") as {
      version: string;
    };
    const r = checkUnpublished({
      ...BASE,
      version: core.version,
      pages: docsPages(),
      listed: UNPUBLISHED_PAGES,
    });
    expect(r.failures).toEqual([]);
    expect(r.counts.listed).toBe(UNPUBLISHED_PAGES.length);
  });
});
