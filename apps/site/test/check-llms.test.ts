import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTE_MCP_URL } from "@authtempo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { checkLlms } from "../scripts/check-llms.ts";
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
const order = sidebarOrder(html);
const groups = sidebarGroups(html);

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A fresh build of the fixture tree into a new temp dist, with the default optional groups. */
function fresh(tree: readonly Page[] = pages, sidebar: readonly string[] = order) {
  const dist = `${mkdtempSync(join(tmpdir(), "check-llms-"))}/`;
  temps.push(dist);
  const index = buildAgentIndex(tree, sidebar, {
    commit: "0123abc",
    readFile,
    terms: {},
    bindings: [],
    groups,
  });
  buildAgentFiles(index, dist);
  // The site build writes the OpenAPI document beside the pages (plan 11g), and llms.txt lists it.
  mkdirSync(`${dist}docs/reference/`, { recursive: true });
  writeFileSync(`${dist}${OPENAPI_FILE}`, "{}\n");
  const files = () => new Set(walk(dist, () => true).map((p) => p.slice(dist.length)));
  return {
    dist,
    files,
    llms: readFileSync(`${dist}llms.txt`, "utf8"),
    full: readFileSync(`${dist}llms-full.txt`, "utf8"),
  };
}

const TWIN = "https://authtempo.com/docs/reference/codes/index.md";
const OPENAPI_FILE = "docs/reference/openapi.json";
const OPENAPI_URL = `https://authtempo.com/${OPENAPI_FILE}`;

describe("checkLlms", () => {
  it("passes on a fresh build", () => {
    const b = fresh();
    const r = checkLlms(b.files(), b.llms, b.full, pages, order, groups);
    expect(r.failures).toEqual([]);
    // Five pages, five twins, the MCP server line, and the OpenAPI document.
    expect(r.counts).toEqual({ pages: 5, links: 7, twins: 5 });
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
    expect(
      checkLlms(without.files(), without.llms, without.full, pages, order, groups).counts,
    ).toEqual({
      pages: 5,
      links: 7,
      twins: 5,
    });

    const guide: Page = {
      path: "docs/guides/agents.mdx",
      source:
        "---\ntitle: Set up an agent\ndescription: Install the MCP server in your editor.\ntype: how-to\n---\n\nText.\n",
    };
    const tree = [...pages, guide];
    const sidebar = [...order, "/docs/guides/agents/"];
    const b = fresh(tree, sidebar);
    const r = checkLlms(b.files(), b.llms, b.full, tree, sidebar, groups);
    expect(r.failures).toEqual([]);
    // One more page, one more link: links stay pages + 2.
    expect(r.counts).toEqual({ pages: 6, links: 8, twins: 6 });
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

  // Review L-1 of Task 4: the default optional groups hold the concept and version pages.
  it("puts the concept and version pages under Optional, after the groups in sidebar order", () => {
    const b = fresh();
    expect(b.llms.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## Tools",
      "## Overview",
      "## How-to guides",
      "## Reference",
      "## Optional",
    ]);
    expect(b.llms.slice(b.llms.indexOf("## Optional"))).toBe(
      [
        "## Optional",
        "",
        "- [Races](https://authtempo.com/docs/concepts/races/index.md): Why two requests at once give one result.",
        "- [Versioning policy](https://authtempo.com/docs/versioning/index.md): How the fixture gives each release a version.",
        "",
      ].join("\n"),
    );
  });

  it("fails when the groups leave the sidebar order", () => {
    const b = fresh();
    const howTo = b.llms.slice(b.llms.indexOf("## How-to guides"), b.llms.indexOf("## Reference"));
    const reference = b.llms.slice(b.llms.indexOf("## Reference"), b.llms.indexOf("## Optional"));
    const swapped = b.llms.replace(`${howTo}${reference}`, `${reference}${howTo}`);
    expect(swapped).not.toBe(b.llms);
    // llms-full.txt follows llms.txt, as the build writes it, so only the H2 order differs.
    const blocks = b.full.split(/\n(?=# )/);
    const sample = blocks.findIndex((x) => x.startsWith("# Sample\n"));
    const codes = blocks.findIndex((x) => x.startsWith("# Codes\n"));
    [blocks[sample], blocks[codes]] = [blocks[codes] ?? "", blocks[sample] ?? ""];
    const full = blocks.join("\n");
    expect(checkLlms(b.files(), swapped, full, pages, order, groups).failures).toEqual([
      "llms.txt: the H2 order is Tools, Overview, Reference, How-to guides, Optional; the sidebar gives Tools, Overview, How-to guides, Reference, Optional",
    ]);
  });

  it("fails on a page under another group", () => {
    const b = fresh();
    const lines = b.llms.split("\n");
    const codes = lines.find((l) => l.startsWith("- [Codes]")) ?? "";
    const sample = lines.find((l) => l.startsWith("- [Sample]")) ?? "";
    // Codes moves to the end of the group before its own: the order of the pages stays.
    const moved = b.llms.replace(`${codes}\n`, "").replace(sample, `${sample}\n${codes}`);
    expect(moved).not.toBe(b.llms);
    expect(checkLlms(b.files(), moved, b.full, pages, order, groups).failures).toEqual([
      "/docs/reference/codes/ is under ## How-to guides, not ## Reference",
    ]);
  });

  it("fails when the MCP server item is under another H2", () => {
    const b = fresh();
    const mcp = b.llms.split("\n").find((l) => l.startsWith("- [MCP server]")) ?? "";
    const moved = `${b.llms.replace(`${mcp}\n`, "")}${mcp}\n`;
    expect(checkLlms(b.files(), moved, b.full, pages, order, groups).failures).toEqual([
      "the MCP server item is under ## Optional, not ## Tools",
    ]);
  });

  it("fails when a page is missing from llms.txt", () => {
    const b = fresh();
    const llms = b.llms.replace(/^- \[Codes\].*\n/m, "");
    expect(llms).not.toBe(b.llms);
    const r = checkLlms(b.files(), llms, b.full, pages, order, groups);
    expect(r.failures).toContain("/docs/reference/codes/ is not listed");
  });

  it("fails on a listed page that the tree lacks, and on a page listed twice", () => {
    const b = fresh();
    // A page that left the tree after the build.
    const fewer = pages.filter((p) => p.path !== "docs/reference/codes.md");
    expect(checkLlms(b.files(), b.llms, b.full, fewer, order, groups).failures).toEqual([
      "/docs/reference/codes/ is listed, but the content tree lacks it",
    ]);
    const line = b.llms.split("\n").find((l) => l.startsWith("- [Codes]")) ?? "";
    const twice = b.llms.replace(`${line}\n`, `${line}\n${line}\n`);
    expect(checkLlms(b.files(), twice, b.full, pages, order, groups).failures).toContain(
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
    expect(checkLlms(b.files(), moved, b.full, pages, order, groups).failures).toContain(
      "llms.txt: the section Overview does not keep the sidebar order",
    );
  });

  it("lists the OpenAPI document under Tools, as a file of the build", () => {
    const b = fresh();
    const item = `- [OpenAPI document](${OPENAPI_URL}): the OpenAPI 3.1 document of every route, for an API client or a code generator.`;
    const tools = b.llms.slice(
      b.llms.indexOf("## Tools"),
      b.llms.indexOf("\n## ", b.llms.indexOf("## Tools") + 1),
    );
    expect(tools).toContain(item);
    expect(b.llms.split(item)).toHaveLength(2);
    // The document is a file, not a page: llms-full.txt holds no text of it.
    expect(b.full).not.toContain(OPENAPI_URL);
  });

  it("fails when a file item names no file of the build", () => {
    const b = fresh();
    rmSync(`${b.dist}${OPENAPI_FILE}`);
    const r = checkLlms(b.files(), b.llms, b.full, pages, order, groups);
    expect(r.failures).toEqual([`a link names no file: ${OPENAPI_URL}`]);
  });

  it("fails when a file item is under another H2", () => {
    const b = fresh();
    const line = b.llms.split("\n").find((l) => l.startsWith("- [OpenAPI document]")) ?? "";
    const moved = `${b.llms.replace(`${line}\n`, "")}${line}\n`;
    expect(moved).not.toBe(b.llms);
    expect(checkLlms(b.files(), moved, b.full, pages, order, groups).failures).toEqual([
      `${OPENAPI_URL} is under ## Optional, not ## Tools`,
    ]);
  });

  it("fails when a link names no file", () => {
    const b = fresh();
    rmSync(`${b.dist}docs/reference/codes/index.md`);
    const r = checkLlms(b.files(), b.llms, b.full, pages, order, groups);
    expect(r.failures).toEqual([`a link names no file: ${TWIN}`]);
  });

  it("fails on a second H1", () => {
    const b = fresh();
    const r = checkLlms(b.files(), `${b.llms}\n# More\n`, b.full, pages, order, groups);
    expect(r.failures).toEqual(["llms.txt holds a second H1: # More"]);
  });

  it("fails on an item without notes", () => {
    const b = fresh();
    const llms = b.llms.replace(
      `(${TWIN}): Every code of the fixture, with its status.`,
      `(${TWIN})`,
    );
    expect(llms).not.toBe(b.llms);
    const r = checkLlms(b.files(), llms, b.full, pages, order, groups);
    expect(r.failures).toContain(
      `llms.txt: an item must have the form - [name](url): notes: - [Codes](${TWIN})`,
    );
  });

  it("fails when the MCP server item is missing", () => {
    const b = fresh();
    const llms = b.llms.replace(/^- \[MCP server\].*\n/m, "");
    expect(llms).not.toBe(b.llms);
    const r = checkLlms(b.files(), llms, b.full, pages, order, groups);
    expect(r.failures).toEqual(["llms.txt has no MCP server item"]);
  });

  it("fails when llms-full.txt has another order", () => {
    const b = fresh();
    // Move the first page of llms-full.txt to its end.
    const blocks = b.full.split(/\n(?=# )/);
    const [head, first, ...rest] = blocks;
    const full = [head, ...rest, first].join("\n");
    expect(full).not.toBe(b.full);
    const r = checkLlms(b.files(), b.llms, full, pages, order, groups);
    expect(r.failures).toEqual([
      "llms-full.txt holds the pages in another order than llms.txt: page 1 is /docs/start/ in llms.txt and /docs/guides/sample/ in llms-full.txt",
    ]);
  });

  it("fails at zero pages", () => {
    const b = fresh();
    const r = checkLlms(b.files(), b.llms, b.full, [], order, groups);
    expect(r.counts.pages).toBe(0);
    expect(r.failures).toContain("read 0 pages");
  });
});
