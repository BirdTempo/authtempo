import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTE_MCP_URL } from "@authtempo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentFiles } from "../scripts/build-agent.ts";
import { checkLlms } from "../scripts/check-llms.ts";
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
const order = sidebarOrder(html);

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A fresh build of the fixture tree into a new temp dist. The fixture has no concept page, so Reference is the optional group. */
function fresh(tree: readonly Page[] = pages, sidebar: readonly string[] = order) {
  const dist = `${mkdtempSync(join(tmpdir(), "check-llms-"))}/`;
  temps.push(dist);
  const index = buildAgentIndex(tree, sidebar, {
    commit: "0123abc",
    readFile,
    terms: {},
    bindings: [],
    groups: sidebarGroups(html),
  });
  buildAgentFiles(index, dist, ["Reference"]);
  const files = () => new Set(walk(dist, () => true).map((p) => p.slice(dist.length)));
  return {
    dist,
    files,
    llms: readFileSync(`${dist}llms.txt`, "utf8"),
    full: readFileSync(`${dist}llms-full.txt`, "utf8"),
  };
}

const TWIN = "https://authtempo.com/docs/reference/codes/index.md";

describe("checkLlms", () => {
  it("passes on a fresh build", () => {
    const b = fresh();
    const r = checkLlms(b.files(), b.llms, b.full, pages, order);
    expect(r.failures).toEqual([]);
    // Three pages, three twins, and the MCP server line.
    expect(r.counts).toEqual({ pages: 3, links: 4, twins: 3 });
    expect(r.exempt).toEqual([
      `${REMOTE_MCP_URL}: the remote MCP server is a planned address, not a file of the build`,
    ]);
    expect(b.llms.startsWith("# authtempo\n\n> ")).toBe(true);
    expect(b.llms).toContain(`- [Codes](${TWIN}): Every code of the fixture, with its status.`);
    expect(b.llms).toContain("\n## Optional\n");
    // The twin is the agent markdown of the page.
    expect(readFileSync(`${b.dist}docs/reference/codes/index.md`, "utf8")).toMatch(
      /^# Codes\n\nEvery code of the fixture/,
    );
    // Each page of llms-full.txt has one title line, then its Source line (review I-3 of Task 3).
    expect(b.full.match(/^# Codes$/gm)).toHaveLength(1);
    expect(b.full).toContain(`\n# Codes\n\nSource: ${TWIN}\n\nEvery code of the fixture`);
  });

  // Ruling 13 of plan 11e: Task 17 writes the agents guide. Until then the
  // build lists no agents line, and after it the guide is under Tools only.
  it("lists the agents guide under Tools only, and only when the tree has it", () => {
    const without = fresh();
    expect(without.llms).not.toContain("guides/agents/");
    expect(checkLlms(without.files(), without.llms, without.full, pages, order).counts).toEqual({
      pages: 3,
      links: 4,
      twins: 3,
    });

    const guide: Page = {
      path: "docs/guides/agents.mdx",
      source:
        "---\ntitle: Set up an agent\ndescription: Install the MCP server in your editor.\ntype: how-to\n---\n\nText.\n",
    };
    const tree = [...pages, guide];
    const sidebar = [...order, "/docs/guides/agents/"];
    const b = fresh(tree, sidebar);
    const r = checkLlms(b.files(), b.llms, b.full, tree, sidebar);
    expect(r.failures).toEqual([]);
    // One more page, one more link: links stay pages + 1.
    expect(r.counts).toEqual({ pages: 4, links: 5, twins: 4 });
    const item =
      "- [Set up an agent](https://authtempo.com/docs/guides/agents/index.md): Install the MCP server in your editor.";
    const tools = b.llms.slice(
      b.llms.indexOf("## Tools"),
      b.llms.indexOf("\n## ", b.llms.indexOf("## Tools") + 1),
    );
    expect(tools).toContain(item);
    expect(b.llms.split(item)).toHaveLength(2);
    // llms-full.txt keeps the order of llms.txt, so the guide is its first page.
    expect(b.full).toMatch(/^# authtempo\n\n> .*\n\n# Set up an agent\n\nSource: /);
  });

  it("fails when a page is missing from llms.txt", () => {
    const b = fresh();
    const llms = b.llms.replace(/^- \[Codes\].*\n/m, "");
    expect(llms).not.toBe(b.llms);
    const r = checkLlms(b.files(), llms, b.full, pages, order);
    expect(r.failures).toContain("/docs/reference/codes/ is not listed");
  });

  it("fails on a listed page that the tree lacks, and on a page listed twice", () => {
    const b = fresh();
    // A page that left the tree after the build.
    const fewer = pages.filter((p) => p.path !== "docs/reference/codes.md");
    expect(checkLlms(b.files(), b.llms, b.full, fewer, order).failures).toEqual([
      "/docs/reference/codes/ is listed, but the content tree lacks it",
    ]);
    const line = b.llms.split("\n").find((l) => l.startsWith("- [Codes]")) ?? "";
    const twice = b.llms.replace(`${line}\n`, `${line}\n${line}\n`);
    expect(checkLlms(b.files(), twice, b.full, pages, order).failures).toContain(
      "/docs/reference/codes/ is listed 2 times",
    );
  });

  it("fails when a section does not keep the sidebar order", () => {
    const b = fresh();
    const lines = b.llms.split("\n");
    const codes = lines.find((l) => l.startsWith("- [Codes]")) ?? "";
    const start = lines.find((l) => l.startsWith("- [Start]")) ?? "";
    // Codes moves into the first section, before Start: the sidebar has Start first.
    const moved = b.llms.replace(`${codes}\n`, "").replace(start, `${codes}\n${start}`);
    expect(moved).not.toBe(b.llms);
    expect(checkLlms(b.files(), moved, b.full, pages, order).failures).toContain(
      "llms.txt: the section Overview does not keep the sidebar order",
    );
  });

  it("fails when a link names no file", () => {
    const b = fresh();
    rmSync(`${b.dist}docs/reference/codes/index.md`);
    const r = checkLlms(b.files(), b.llms, b.full, pages, order);
    expect(r.failures).toEqual([`a link names no file: ${TWIN}`]);
  });

  it("fails on a second H1", () => {
    const b = fresh();
    const r = checkLlms(b.files(), `${b.llms}\n# More\n`, b.full, pages, order);
    expect(r.failures).toEqual(["llms.txt holds a second H1: # More"]);
  });

  it("fails on an item without notes", () => {
    const b = fresh();
    const llms = b.llms.replace(
      `(${TWIN}): Every code of the fixture, with its status.`,
      `(${TWIN})`,
    );
    expect(llms).not.toBe(b.llms);
    const r = checkLlms(b.files(), llms, b.full, pages, order);
    expect(r.failures).toContain(
      `llms.txt: an item must have the form - [name](url): notes: - [Codes](${TWIN})`,
    );
  });

  it("fails when the MCP server item is missing", () => {
    const b = fresh();
    const llms = b.llms.replace(/^- \[MCP server\].*\n/m, "");
    expect(llms).not.toBe(b.llms);
    const r = checkLlms(b.files(), llms, b.full, pages, order);
    expect(r.failures).toEqual(["llms.txt has no MCP server item"]);
  });

  it("fails when llms-full.txt has another order", () => {
    const b = fresh();
    // Move the first page of llms-full.txt to its end.
    const blocks = b.full.split(/\n(?=# )/);
    const [head, first, ...rest] = blocks;
    const full = [head, ...rest, first].join("\n");
    expect(full).not.toBe(b.full);
    const r = checkLlms(b.files(), b.llms, full, pages, order);
    expect(r.failures).toEqual([
      "llms-full.txt holds the pages in another order than llms.txt: page 1 is /docs/start/ in llms.txt and /docs/guides/sample/ in llms-full.txt",
    ]);
  });

  it("fails at zero pages", () => {
    const b = fresh();
    const r = checkLlms(b.files(), b.llms, b.full, [], order);
    expect(r.counts.pages).toBe(0);
    expect(r.failures).toContain("read 0 pages");
  });
});
