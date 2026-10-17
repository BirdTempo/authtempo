import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentIndex } from "@authtempo/mcp/index-format";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_TERMS } from "../scripts/check-terms.ts";
import {
  agentMarkdown,
  bindingsOf,
  buildAgentIndex,
  type ReadFile,
  sidebarGroups,
  sidebarOrder,
  termsOf,
} from "../scripts/lib/agent.ts";
import { EXPORT_ENTRIES, SDK_PACKAGES } from "../scripts/lib/entries.ts";
import { walk } from "../scripts/lib/files.ts";
import type { Page } from "../scripts/lib/markdown.ts";

// A content tree of three pages, one sample, and a built page with a sidebar.
const ROOT = fileURLToPath(new URL("./fixtures/agent/", import.meta.url));
const pages: Page[] = walk(`${ROOT}docs/`, (p) => /\.mdx?$/.test(p)).map((p) => ({
  path: p.slice(ROOT.length),
  source: readFileSync(p, "utf8"),
}));
const readFile: ReadFile = (path) => readFileSync(resolve(ROOT, path), "utf8");
const html = readFileSync(`${ROOT}index.html`, "utf8");

function page(path: string): Page {
  const p = pages.find((x) => x.path === path);
  if (!p) throw new Error(`the fixture lacks ${path}`);
  return p;
}
const reference = page("docs/reference/codes.md");
const howTo = page("docs/guides/sample.mdx");
const start = page("docs/start/index.md");

/** The lines of a markdown text that are outside every fence. */
function prose(markdown: string): string[] {
  let fence = false;
  return markdown.split("\n").filter((line) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fence = !fence;
      return false;
    }
    return !fence;
  });
}

function build(order = sidebarOrder(html)) {
  return buildAgentIndex(pages, order, {
    commit: "0123abc",
    readFile,
    terms: termsOf(FORBIDDEN_TERMS),
    bindings: bindingsOf(EXPORT_ENTRIES, SDK_PACKAGES),
    groups: sidebarGroups(html),
  });
}

describe("agentMarkdown", () => {
  it("keeps the text and drops the frontmatter and the imports", () => {
    const md = agentMarkdown(reference, readFile);
    expect(md.startsWith("# Codes\n\nEvery code of the fixture, with its status.\n\n")).toBe(true);
    expect(md).toContain("**What it does:** this page lists two codes. Each code has an anchor.");
    expect(md).toContain("## Before you start");
    expect(md).not.toMatch(/^---$|^title:|^sources:|^sidebar:/m);
    const sample = agentMarkdown(howTo, readFile);
    expect(sample).not.toMatch(/^import\s/m);
    expect(sample).toContain("1. Read the sample.");
  });

  it("inlines each sample include as a fence with the file's text", () => {
    const lines = agentMarkdown(howTo, readFile).split("\n");
    const sample = readFileSync(`${ROOT}samples/hello.ts`, "utf8");
    const open = lines.indexOf("`````ts");
    expect(open).toBeGreaterThan(0);
    expect(lines.filter((l) => /^`{3,}ts$/.test(l))).toHaveLength(1);
    expect(lines[open + 1]).toBe("// samples/hello.ts");
    const close = lines.indexOf("`````", open + 1);
    expect(close).toBeGreaterThan(open);
    expect(`${lines.slice(open + 2, close).join("\n")}\n`).toBe(sample);
  });

  it("turns a raw h3 anchor into a heading with its id", () => {
    const md = agentMarkdown(reference, readFile);
    expect(md).toContain("\n### invalid_body 400 {#invalid_body}\n");
    expect(md).toContain("\n### unauthorized 401 {#unauthorized}\n");
    expect(md).not.toContain("<h3");
  });

  it("makes each internal link absolute, and keeps an external link", () => {
    const md = agentMarkdown(reference, readFile);
    expect(md).toContain("[start page](https://authtempo.com/docs/start/)");
    expect(md).toContain("[Sample](https://authtempo.com/docs/guides/sample/#the-steps)");
    expect(md).toContain("[The source](https://github.com/example/repo)");
    expect(md).not.toContain("](/docs/");
    const table = agentMarkdown(start, readFile);
    expect(table).toContain(
      "| [Sample](https://authtempo.com/docs/guides/sample/) | One sample include |",
    );
    expect(table).toContain("| --- | --- |");
  });

  it("strips every HTML and MDX element to text", () => {
    for (const p of pages) {
      const outside = prose(agentMarkdown(p, readFile));
      expect(outside.filter((l) => /<[A-Za-z]/.test(l))).toEqual([]);
    }
    const md = agentMarkdown(reference, readFile);
    expect(md).toContain("The body is not valid JSON. See the spec at https://example.com/spec.");
  });

  it("throws on an include of a file that does not exist", () => {
    const none: ReadFile = (path) => {
      throw new Error(`ENOENT: ${path}`);
    };
    expect(() => agentMarkdown(howTo, none)).toThrow(
      "docs/guides/sample.mdx: the include hello names ../../samples/hello.ts, which does not exist",
    );
  });
});

describe("the agent index", () => {
  it("reads the sidebar order from a built page", () => {
    expect(sidebarOrder(html)).toEqual([
      "/docs/start/",
      "/docs/guides/sample/",
      "/docs/reference/codes/",
    ]);
  });

  it("writes one entry per page and one per section, in the sidebar order", () => {
    const index = build();
    expect(index.pages.map((p) => [p.path, p.type, p.group])).toEqual([
      ["/docs/start/", "tutorial", ""],
      ["/docs/guides/sample/", "how-to", "How-to guides"],
      ["/docs/reference/codes/", "reference", "Reference"],
    ]);
    expect(index.sections.map((s) => [s.path, s.depth, s.heading, s.anchor])).toEqual([
      ["/docs/start/", 2, "The pages", "the-pages"],
      ["/docs/start/", 2, "Next", "next"],
      ["/docs/guides/sample/", 2, "Before you start", "before-you-start"],
      ["/docs/guides/sample/", 2, "The steps", "the-steps"],
      ["/docs/guides/sample/", 2, "If it fails", "if-it-fails"],
      ["/docs/guides/sample/", 2, "Next", "next"],
      ["/docs/reference/codes/", 2, "Before you start", "before-you-start"],
      ["/docs/reference/codes/", 2, "The codes", "the-codes"],
      ["/docs/reference/codes/", 3, "invalid_body 400", "invalid_body"],
      ["/docs/reference/codes/", 3, "unauthorized 401", "unauthorized"],
      ["/docs/reference/codes/", 2, "Next", "next"],
    ]);
    const codes = index.sections.find((s) => s.anchor === "invalid_body");
    expect(codes?.text).toBe(
      "The body is not valid JSON. See the spec at https://example.com/spec.",
    );
    expect(index.pages[2]?.links).toEqual(["/docs/start/", "/docs/guides/sample/#the-steps"]);
    expect(index.header).toMatchObject({
      format: 1,
      commit: "0123abc",
      builtFrom: "apps/site/src/content/docs/docs/",
      pages: 3,
      sections: 11,
      versions: ["latest"],
    });
    expect(parseAgentIndex(JSON.stringify(index))).toEqual(index);
  });

  it("puts each forbidden term and each binding in the header", () => {
    const { header } = build();
    expect(header.terms["2fa"]).toBe("second factor");
    expect(header.terms["log in"]).toBe("sign in");
    expect(Object.keys(header.terms)).toHaveLength(FORBIDDEN_TERMS.length);
    expect(header.bindings).toContainEqual({ name: "hono", page: "/docs/reference/hono/" });
    expect(header.bindings).toContainEqual({ name: "vue-nuxt", page: "/docs/reference/vue/" });
    const names = header.bindings.map((b) => b.name);
    for (const no of [
      "core",
      "core-routes",
      "client",
      "client-oauth",
      "verify",
      "handoff",
      "handoff-expo",
    ])
      expect(names).not.toContain(no);
    // Every row of a binding package is in the list, and no row is twice.
    const bindingPackages = SDK_PACKAGES.filter(
      (p) =>
        ![
          "@authtempo/core",
          "@authtempo/client",
          "@authtempo/verify",
          "@authtempo/handoff",
        ].includes(p),
    );
    const rows = EXPORT_ENTRIES.filter((e) => bindingPackages.includes(e.pkg));
    expect(new Set(names).size).toBe(names.length);
    expect(names.toSorted()).toEqual(rows.map((e) => e.label).toSorted());
  });

  it("fails on a page that the sidebar does not list, and on a sidebar link with no page", () => {
    const order = sidebarOrder(html);
    expect(() => build(order.filter((p) => p !== "/docs/start/"))).toThrow(
      "/docs/start/: the sidebar does not list the page",
    );
    expect(() => build([...order, "/docs/missing/"])).toThrow(
      "/docs/missing/: the sidebar links a page that does not exist",
    );
  });
});
