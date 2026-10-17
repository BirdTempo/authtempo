import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkAgentIndex, sampleIncludes } from "../scripts/check-agent-index.ts";
import {
  buildAgentIndex,
  type ReadFile,
  sidebarGroups,
  sidebarOrder,
} from "../scripts/lib/agent.ts";
import { walk } from "../scripts/lib/files.ts";
import type { Page } from "../scripts/lib/markdown.ts";

// The content tree of Task 3: three pages, one sample, and a built page with a sidebar.
const ROOT = fileURLToPath(new URL("./fixtures/agent/", import.meta.url));
const pages: Page[] = walk(`${ROOT}docs/`, (p) => /\.mdx?$/.test(p)).map((p) => ({
  path: p.slice(ROOT.length),
  source: readFileSync(p, "utf8"),
}));
const readFile: ReadFile = (path) => readFileSync(resolve(ROOT, path), "utf8");
const html = readFileSync(`${ROOT}index.html`, "utf8");

/**
 * A built page as Starlight writes it: the title, the heading of the page
 * contents, and one h2 or h3 with an id per section of the page.
 */
function built(headings: string[]): string {
  const body = headings.map((h) => {
    const level = h.startsWith("### ") ? 3 : 2;
    return `<h${level} id="${h.replace(/^#+ /, "")}">x</h${level}>`;
  });
  return `<h1 id="_top">T</h1><h2 id="starlight__on-this-page">On this page</h2>${body.join("")}`;
}

/** The built pages of the fixture tree, with the ids that the site build gives each heading. */
function distOf(change: Record<string, string[]> = {}): Map<string, string> {
  const ids: Record<string, string[]> = {
    "docs/start/index.html": [
      "## the-pages",
      "### example",
      "## more-pages",
      "### example-1",
      "## next",
    ],
    "docs/guides/sample/index.html": [
      "## before-you-start",
      "## the-steps",
      "## if-it-fails",
      "## next",
    ],
    "docs/reference/codes/index.html": [
      "## before-you-start",
      "## the-codes",
      "### invalid_body",
      "### unauthorized",
      "## next",
    ],
    ...change,
  };
  return new Map(Object.entries(ids).map(([file, h]) => [file, built(h)]));
}

function indexText(tree: readonly Page[] = pages, order = sidebarOrder(html)): string {
  const index = buildAgentIndex(tree, order, {
    commit: "0123abc",
    readFile,
    terms: {},
    bindings: [],
    groups: sidebarGroups(html),
  });
  return JSON.stringify(index, null, 2);
}

describe("checkAgentIndex", () => {
  it("passes on a fresh build", () => {
    const r = checkAgentIndex(indexText(), pages, distOf(), sampleIncludes(pages, readFile));
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 3, sections: 14, samples: 1 });
  });

  it("fails when the parser refuses the index", () => {
    const r = checkAgentIndex("{", pages, distOf(), sampleIncludes(pages, readFile));
    expect(r.failures[0]).toMatch(/^the agent index is not JSON: /);
  });

  it("fails on an anchor that the page lacks", () => {
    const codes = ["## before-you-start", "## the-codes", "### unauthorized", "## next"];
    const r = checkAgentIndex(
      indexText(),
      pages,
      distOf({ "docs/reference/codes/index.html": codes }),
      sampleIncludes(pages, readFile),
    );
    expect(r.failures).toEqual([
      "/docs/reference/codes/#invalid_body: the built page has no such id",
    ]);
  });

  it("fails when the anchors of a page differ in order from its headings", () => {
    // A repeat heading with the wrong id: each id exists on the page, but not in this order.
    const start = ["## the-pages", "### example-1", "## more-pages", "### example", "## next"];
    const r = checkAgentIndex(
      indexText(),
      pages,
      distOf({ "docs/start/index.html": start }),
      sampleIncludes(pages, readFile),
    );
    expect(r.failures).toEqual([
      "/docs/start/: the anchors differ from the headings of the built page: the-pages, example, more-pages, example-1, next in the index; the-pages, example-1, more-pages, example, next on the page",
    ]);
  });

  it("fails on a fence that differs from its sample", () => {
    const text = indexText();
    // The sample changed after the build, so the fence of the index is old.
    const changed: ReadFile = (path) =>
      path === "samples/hello.ts" ? `${readFile(path)}export const late = 1;\n` : readFile(path);
    const r = checkAgentIndex(text, pages, distOf(), sampleIncludes(pages, changed));
    expect(r.failures).toEqual([
      "/docs/guides/sample/: no ts fence holds the text of samples/hello.ts",
    ]);
  });

  it("fails on a title line in a language where // is no comment", () => {
    const odd = pages.map((p) =>
      p.path === "docs/guides/sample.mdx"
        ? { ...p, source: p.source.replace('lang="ts"', 'lang="sh"') }
        : p,
    );
    const r = checkAgentIndex(indexText(odd), odd, distOf(), sampleIncludes(odd, readFile));
    expect(r.failures).toEqual([
      "/docs/guides/sample/: the sample samples/hello.ts has a title, and its // line is no comment in sh (the title line suits ts, tsx, jsonc)",
    ]);
  });

  it("fails on a page that the tree lacks, and on a page that the index lacks", () => {
    const text = indexText();
    const samples = sampleIncludes(pages, readFile);
    // A page that left the tree after the build.
    const fewer = pages.filter((p) => p.path !== "docs/start/index.md");
    expect(checkAgentIndex(text, fewer, distOf(), samples).failures).toEqual([
      "the content tree lacks /docs/start/, which the index holds",
    ]);
    // A page that came into the tree after the build.
    const extra: Page = {
      path: "docs/guides/extra.md",
      source: "---\ntitle: Extra\ndescription: One more page.\ntype: how-to\n---\n\nText.\n",
    };
    expect(checkAgentIndex(text, [...pages, extra], distOf(), samples).failures).toEqual([
      "the index lacks /docs/guides/extra/",
    ]);
  });

  it("fails at zero sections", () => {
    // A tree whose one page has no heading: the build gives no section.
    const one: Page = {
      path: "docs/start/index.md",
      source: "---\ntitle: Start\ndescription: One page.\ntype: tutorial\n---\n\nText.\n",
    };
    const r = checkAgentIndex(
      indexText([one], ["/docs/start/"]),
      [one],
      new Map([["docs/start/index.html", built([])]]),
      [],
    );
    expect(r.counts).toEqual({ pages: 1, sections: 0, samples: 0 });
    expect(r.failures).toEqual(["read 0 sections", "read 0 samples"]);
  });
});
