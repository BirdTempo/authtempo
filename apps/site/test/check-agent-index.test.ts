import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkAgentIndex, sampleIncludes } from "../scripts/check-agent-index.ts";
import {
  buildAgentIndex,
  type ReadFile,
  sidebarGroups,
  sidebarOrder,
} from "../scripts/lib/agent.ts";
import { buildAgentFiles } from "../scripts/lib/agent-files.ts";
import { walk } from "../scripts/lib/files.ts";
import type { Page } from "../scripts/lib/markdown.ts";

// The fixture tree: five pages, one sample, and a built page with a sidebar.
const ROOT = fileURLToPath(new URL("./fixtures/agent/", import.meta.url));
const pages: Page[] = walk(`${ROOT}docs/`, (p) => /\.mdx?$/.test(p)).map((p) => ({
  path: p.slice(ROOT.length),
  source: readFileSync(p, "utf8"),
}));
const readFile: ReadFile = (path) => readFileSync(resolve(ROOT, path), "utf8");
const html = readFileSync(`${ROOT}index.html`, "utf8");

/**
 * A built page as Starlight writes it. It has the title, the heading of the
 * page contents, and one h2 or h3 with an id per section.
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
    "docs/concepts/races/index.html": ["## the-rule"],
    "docs/versioning/index.html": ["## the-rule"],
    ...change,
  };
  return new Map(Object.entries(ids).map(([file, h]) => [file, built(h)]));
}

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/**
 * A build of a tree: the index text, and a reader of the twins and
 * llms-full.txt that buildAgentFiles wrote into a new temp dist.
 */
function build(tree: readonly Page[] = pages, order = sidebarOrder(html)) {
  const index = buildAgentIndex(tree, order, {
    commit: "0123abc",
    readFile,
    terms: {},
    bindings: [],
    groups: sidebarGroups(html),
  });
  const dist = `${mkdtempSync(join(tmpdir(), "check-agent-index-"))}/`;
  temps.push(dist);
  // No optional group: an in-test tree has no concept or version page.
  buildAgentFiles(index, dist, []);
  const read = (file: string): string | null => {
    try {
      return readFileSync(`${dist}${file}`, "utf8");
    } catch {
      return null;
    }
  };
  return { text: JSON.stringify(index, null, 2), dist, read };
}

const samples = sampleIncludes(pages, readFile);

describe("checkAgentIndex", () => {
  it("passes on a fresh build", () => {
    const b = build();
    const r = checkAgentIndex(b.text, pages, distOf(), samples, b.read);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 5, sections: 16, samples: 1, twins: 5, bodies: 5 });
  });

  it("fails when the parser refuses the index", () => {
    const r = checkAgentIndex("{", pages, distOf(), samples, build().read);
    expect(r.failures[0]).toMatch(/^the agent index is not JSON: /);
  });

  it("fails on an anchor that the page lacks", () => {
    const codes = ["## before-you-start", "## the-codes", "### unauthorized", "## next"];
    const b = build();
    const r = checkAgentIndex(
      b.text,
      pages,
      distOf({ "docs/reference/codes/index.html": codes }),
      samples,
      b.read,
    );
    expect(r.failures).toEqual([
      "/docs/reference/codes/#invalid_body: the built page has no such id",
    ]);
  });

  it("fails when the anchors of a page differ in order from its headings", () => {
    // A repeat heading with the wrong id: each id exists on the page, but not in this order.
    const start = ["## the-pages", "### example-1", "## more-pages", "### example", "## next"];
    const b = build();
    const r = checkAgentIndex(
      b.text,
      pages,
      distOf({ "docs/start/index.html": start }),
      samples,
      b.read,
    );
    expect(r.failures).toEqual([
      "/docs/start/: the anchors differ from the headings of the built page: the-pages, example, more-pages, example-1, next in the index; the-pages, example-1, more-pages, example, next on the page",
    ]);
  });

  // Review L-2 of Task 4: each twin and each page of llms-full.txt equals the index markdown.
  it("fails on a twin that differs from the index", () => {
    const b = build();
    const twin = `${b.dist}docs/reference/codes/index.md`;
    // One section is cut from the twin.
    writeFileSync(
      twin,
      readFileSync(twin, "utf8").replace(/\n### unauthorized[\s\S]*?(?=\n## )/, ""),
    );
    const r = checkAgentIndex(b.text, pages, distOf(), samples, b.read);
    expect(r.failures).toEqual([
      "/docs/reference/codes/: the twin differs from the markdown of the index",
    ]);
  });

  it("fails on a page of llms-full.txt that differs from the index", () => {
    const b = build();
    const full = `${b.dist}llms-full.txt`;
    // The body of one page loses its last line.
    writeFileSync(
      full,
      readFileSync(full, "utf8").replace(
        "\nA change that breaks a caller gives a new major version.",
        "",
      ),
    );
    const r = checkAgentIndex(b.text, pages, distOf(), samples, b.read);
    expect(r.failures).toEqual([
      "/docs/versioning/: llms-full.txt does not hold the page as the index has it",
    ]);
  });

  it("fails on a fence that differs from its sample", () => {
    const b = build();
    // The sample changed after the build, so the fence of the index is old.
    const changed: ReadFile = (path) =>
      path === "samples/hello.ts" ? `${readFile(path)}export const late = 1;\n` : readFile(path);
    const r = checkAgentIndex(b.text, pages, distOf(), sampleIncludes(pages, changed), b.read);
    expect(r.failures).toEqual([
      "/docs/guides/sample/: no ts fence holds the text of samples/hello.ts",
    ]);
  });

  // Review I-4 of Task 4: an include with no ?raw import fails, and is not skipped.
  it("fails on an include that no import names", () => {
    const b = build();
    // The page lost its import after the build.
    const edited = pages.map((p) =>
      p.path === "docs/guides/sample.mdx"
        ? { ...p, source: p.source.replace(/^import hello from .*\n/m, "") }
        : p,
    );
    expect(edited).not.toEqual(pages);
    const r = checkAgentIndex(b.text, edited, distOf(), sampleIncludes(edited, readFile), b.read);
    expect(r.failures).toEqual(["/docs/guides/sample/: the include hello has no ?raw import"]);
  });

  it("fails on a title line in a language where // is no comment", () => {
    const odd = pages.map((p) =>
      p.path === "docs/guides/sample.mdx"
        ? { ...p, source: p.source.replace('lang="ts"', 'lang="sh"') }
        : p,
    );
    const b = build(odd);
    const r = checkAgentIndex(b.text, odd, distOf(), sampleIncludes(odd, readFile), b.read);
    expect(r.failures).toEqual([
      "/docs/guides/sample/: the sample samples/hello.ts has a title, and its // line is no comment in sh (the title line suits ts, tsx, jsonc)",
    ]);
  });

  it("fails on a page that the tree lacks, and on a page that the index lacks", () => {
    const b = build();
    // A page that left the tree after the build.
    const fewer = pages.filter((p) => p.path !== "docs/start/index.md");
    expect(checkAgentIndex(b.text, fewer, distOf(), samples, b.read).failures).toEqual([
      "the content tree lacks /docs/start/, which the index holds",
    ]);
    // A page that came into the tree after the build.
    const extra: Page = {
      path: "docs/guides/extra.md",
      source: "---\ntitle: Extra\ndescription: One more page.\ntype: how-to\n---\n\nText.\n",
    };
    expect(checkAgentIndex(b.text, [...pages, extra], distOf(), samples, b.read).failures).toEqual([
      "the index lacks /docs/guides/extra/",
    ]);
  });

  it("fails at zero sections", () => {
    // A tree whose one page has no heading: the build gives no section.
    const one: Page = {
      path: "docs/start/index.md",
      source: "---\ntitle: Start\ndescription: One page.\ntype: tutorial\n---\n\nText.\n",
    };
    const b = build([one], ["/docs/start/"]);
    const r = checkAgentIndex(
      b.text,
      [one],
      new Map([["docs/start/index.html", built([])]]),
      [],
      b.read,
    );
    expect(r.counts).toEqual({ pages: 1, sections: 0, samples: 0, twins: 1, bodies: 1 });
    expect(r.failures).toEqual(["read 0 sections", "read 0 samples"]);
  });
});
