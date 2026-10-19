// The docs tools: docs.search, docs.read, and version. They read the index
// that the server loaded at its start, and nothing else. They run on Node
// and on the remote Worker.
import type { AgentIndex, AgentPage, AgentSection } from "./index-format.js";
import { searchSections } from "./search.js";
import type { ToolImpl, ToolResult } from "./spec.js";
import { TOOLS, type ToolRow } from "./tools.js";

/** The facts of the version tool that do not come from the index. */
export interface VersionFacts {
  core: string;
  /** Null on the remote surface: the Worker cannot read the CLI's package.json (deviation 18). */
  cli: string | null;
  mcp: string;
  schemaVersion: number;
  protocol: string;
}

function row(name: string): ToolRow {
  const r = TOOLS.find((t) => t.name === name);
  if (!r) throw new Error(`the tool table has no row ${name}`);
  return r;
}

const done = (structured: Record<string, unknown>): ToolResult => ({ structured, isError: false });
const fault = (structured: { error: string } & Record<string, unknown>): ToolResult => ({
  structured,
  isError: true,
});

/** A version that the index lacks is a tool fault that lists the versions it has. */
function versionFault(index: AgentIndex, version: unknown): ToolResult | null {
  if (typeof version === "string" && index.header.versions.includes(version)) return null;
  return fault({
    error: `the docs version ${String(version)} is not in the index`,
    versions: index.header.versions,
  });
}

// The text of the index answer. The site build writes /llms.txt from the same
// index (apps/site/scripts/build-agent.ts, llmsText). The Worker cannot read
// the site's scripts, so this is a second writer of one text. The test
// docs-tools.test.ts holds the two byte-equal, so they cannot drift in silence.
const SITE_ORIGIN = "https://authtempo.com";
/** The address of the remote server. test/remote-address.test.ts holds it to the Worker and the CLI. */
export const REMOTE_MCP_URL = "https://mcp.authtempo.com/mcp";
const OPTIONAL_GROUPS: readonly string[] = ["Concepts", "Versions"];
const TOP_LEVEL_SECTION = "Overview";
const AGENTS_GUIDE = "/docs/guides/agents/";
const LLMS_HEAD = [
  "# authtempo",
  "",
  "> An auth engine for TypeScript on Workers, Node, and Bun. The docs are under https://authtempo.com/docs/.",
  "",
  "These docs are the source of every fact about authtempo. This file lists every page, and /llms-full.txt holds the text of every page. An agent can also read the docs through the MCP server: run `authtempo mcp --claude-code` or another target in your project.",
  "",
  "## Tools",
  "",
];

const twinUrl = (path: string) => `${SITE_ORIGIN}/${path.slice(1)}index.md`;
const item = (name: string, url: string, notes: string) => `- [${name}](${url}): ${notes}`;

/** The text of /llms.txt, rebuilt from the index. */
export function llmsText(index: AgentIndex): string {
  const out = [...LLMS_HEAD];
  out.push(
    item(
      "MCP server",
      REMOTE_MCP_URL,
      "the remote docs server, with the docs tools only and no sign-in.",
    ),
  );
  const guide = index.pages.find((p) => p.path === AGENTS_GUIDE);
  if (guide) out.push(item(guide.title, twinUrl(guide.path), guide.description));
  // The OpenAPI document of plan 11g is a file of the site build, not a page, so it has no twin.
  out.push(
    item(
      "OpenAPI document",
      `${SITE_ORIGIN}/docs/reference/openapi.json`,
      "the OpenAPI 3.1 document of every route, for an API client or a code generator.",
    ),
  );
  const groups = new Map<string, AgentPage[]>();
  for (const page of index.pages) {
    if (page.path === AGENTS_GUIDE) continue;
    const list = groups.get(page.group) ?? [];
    list.push(page);
    groups.set(page.group, list);
  }
  const sections: { heading: string; pages: AgentPage[] }[] = [];
  for (const [group, pages] of groups)
    if (!OPTIONAL_GROUPS.includes(group))
      sections.push({ heading: group === "" ? TOP_LEVEL_SECTION : group, pages });
  sections.push({
    heading: "Optional",
    pages: OPTIONAL_GROUPS.flatMap((g) => groups.get(g) ?? []),
  });
  for (const s of sections) {
    out.push("", `## ${s.heading}`, "");
    for (const p of s.pages) out.push(item(p.title, twinUrl(p.path), p.description));
  }
  return `${out.join("\n")}\n`;
}

/** The edit distance of two strings, by characters. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1)
      next.push(
        Math.min(
          (prev[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    prev = next;
  }
  return prev[b.length] ?? 0;
}

const segments = (path: string) => path.split("/").filter((s) => s.length > 0);

/**
 * The edit distance of two paths over their segments. A segment that is
 * added or dropped costs 1. A changed segment costs its character distance
 * over its length. So "magic-links" is nearer to "magic-link" than to "jwt".
 */
function pathDistance(a: string, b: string): number {
  const x = segments(a);
  const y = segments(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const s = x[i - 1] ?? "";
      const t = y[j - 1] ?? "";
      const change = s === t ? 0 : distance(s, t) / Math.max(s.length, t.length);
      next.push(Math.min((prev[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + change));
    }
    prev = next;
  }
  return prev[y.length] ?? 0;
}

/** The three page paths nearest to a path; a tie follows the sidebar order. */
export function nearestPaths(index: AgentIndex, path: string): string[] {
  return index.pages
    .map((p, i) => ({ path: p.path, i, d: pathDistance(path, p.path) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, 3)
    .map((p) => p.path);
}

/**
 * The page path of a path as an agent may type it. The site origin goes, and
 * a final slash comes. The handler only looks the result up in the index.
 */
function pagePath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith(SITE_ORIGIN)) path = path.slice(SITE_ORIGIN.length);
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * The markdown of one section. A level-2 section also holds each level-3
 * section under it, up to the next level-2 heading. Many level-2 headings
 * have no text of their own: their content is in their level-3 children.
 */
function sectionMarkdown(sections: readonly AgentSection[], s: AgentSection): string {
  const out = [`${"#".repeat(s.depth)} ${s.heading}\n\n${s.text}\n`];
  if (s.depth === 2)
    for (const next of sections.slice(sections.indexOf(s) + 1)) {
      if (next.depth === 2) break;
      out.push(`\n### ${next.heading}\n\n${next.text}\n`);
    }
  return out.join("");
}

function search(index: AgentIndex): ToolImpl {
  return {
    row: row("docs.search"),
    async call(input) {
      const bad = versionFault(index, input.version);
      if (bad) return bad;
      const type = input.type as AgentPage["type"] | undefined;
      const results = searchSections(index, String(input.query), {
        limit: Number(input.limit),
        ...(type === undefined ? {} : { type }),
      });
      return done({ version: input.version, results });
    },
  };
}

function read(index: AgentIndex): ToolImpl {
  return {
    row: row("docs.read"),
    async call(input) {
      const bad = versionFault(index, input.version);
      if (bad) return bad;
      const version = input.version;
      if (input.path === undefined) {
        if (input.section !== undefined)
          return fault({ error: "a section needs a path", anchors: [] });
        return done({
          version,
          path: "/docs/",
          title: "authtempo docs index",
          description: "Every page of the authtempo docs, by its sidebar group.",
          type: "reference",
          sources: [index.header.builtFrom],
          markdown: llmsText(index),
          links: index.pages.map((p) => p.path),
        });
      }
      const path = pagePath(String(input.path));
      const page = index.pages.find((p) => p.path === path);
      if (!page) {
        const suggestions = nearestPaths(index, path);
        return fault({
          error: `the docs have no page ${path}. The nearest paths: ${suggestions.join(", ")}`,
          suggestions,
        });
      }
      let markdown = page.markdown;
      if (input.section !== undefined) {
        const sections = index.sections.filter((s) => s.path === path);
        const s = sections.find((x) => x.anchor === input.section);
        if (!s)
          return fault({
            error: `the page ${path} has no section ${String(input.section)}`,
            anchors: sections.map((x) => x.anchor),
          });
        markdown = sectionMarkdown(sections, s);
      }
      return done({
        version,
        path: page.path,
        title: page.title,
        description: page.description,
        type: page.type,
        sources: page.sources,
        markdown,
        links: page.links,
      });
    },
  };
}

function version(index: AgentIndex, facts: VersionFacts): ToolImpl {
  return {
    row: row("version"),
    async call() {
      return done({
        core: facts.core,
        cli: facts.cli,
        mcp: facts.mcp,
        schemaVersion: facts.schemaVersion,
        protocol: facts.protocol,
        docsIndex: {
          commit: index.header.commit,
          pages: index.header.pages,
          builtFrom: index.header.builtFrom,
        },
      });
    },
  };
}

/** The three docs tools over one index. */
export function docsTools(index: AgentIndex, facts: VersionFacts): ToolImpl[] {
  return [search(index), read(index), version(index, facts)];
}
