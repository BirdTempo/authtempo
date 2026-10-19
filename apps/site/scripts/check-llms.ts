import { REMOTE_MCP_URL } from "@authtempo/cli";
import { pageUrl } from "./check-frontmatter.ts";
import { SITE_ORIGIN } from "./lib/agent.ts";
import { AGENTS_GUIDE, OPTIONAL_GROUPS, TOP_LEVEL_SECTION } from "./lib/agent-files.ts";
import type { Page } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

const ITEM = /^- \[([^\]]+)\]\((\S+)\): (\S.*)$/;
const TWIN = new RegExp(
  `^${SITE_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/((?:docs/)(?:[a-z0-9-]+/)*)index\\.md$`,
);

/** The URL path of the page of a twin URL, or null when the URL is no twin. */
function pathOfTwin(url: string): string | null {
  const m = TWIN.exec(url);
  return m ? `/${m[1]}` : null;
}

/**
 * The H2 that llms.txt must give a page. The agents guide is under Tools, and
 * a page of an optional group under Optional. A top-level page is under
 * Overview, and each other page under its sidebar group. Null when the
 * sidebar gives the page no group.
 */
function headingOf(path: string, groups: Readonly<Record<string, string>>): string | null {
  if (path === AGENTS_GUIDE) return "Tools";
  const group = groups[path];
  if (group === undefined) return null;
  if (OPTIONAL_GROUPS.includes(group)) return "Optional";
  return group === "" ? TOP_LEVEL_SECTION : group;
}

/**
 * llms.txt keeps the llmstxt.org form, and lists every page of the content
 * tree once by its .md twin, which the build wrote. Each page is under its
 * H2, and the H2s keep the sidebar order. llms-full.txt holds the same pages
 * in the same order. `files` are the paths of dist. `order` and `groups` are
 * the sidebar order and the sidebar group of each URL path.
 */
export function checkLlms(
  files: ReadonlySet<string>,
  llmsText: string,
  fullText: string,
  pages: readonly Page[],
  order: readonly string[],
  groups: Readonly<Record<string, string>>,
): CheckReport {
  const r: CheckReport = {
    name: "check-llms",
    counts: { pages: pages.length, links: 0, twins: 0 },
    failures: [],
    exempt: [],
  };
  const lines = llmsText.split("\n");
  if (lines[0] !== "# authtempo") r.failures.push("llms.txt does not start with # authtempo");
  for (const line of lines.slice(1))
    if (/^# /.test(line)) r.failures.push(`llms.txt holds a second H1: ${line}`);

  const listed: string[] = [];
  const sections = new Map<string, string[]>();
  let section = "";
  let mcp: string | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) section = line.slice(3);
    if (!line.startsWith("- ")) continue;
    const m = ITEM.exec(line);
    if (!m) {
      r.failures.push(`llms.txt: an item must have the form - [name](url): notes: ${line}`);
      continue;
    }
    const url = m[2] ?? "";
    r.counts.links = (r.counts.links ?? 0) + 1;
    if (url === REMOTE_MCP_URL) {
      mcp = section;
      r.exempt?.push(`${url}: the remote MCP server is a planned address, not a file of the build`);
      continue;
    }
    const path = pathOfTwin(url);
    if (path === null) {
      // A file of the build that is not a page, such as the OpenAPI document (plan 11g), is a tool.
      const file = url.startsWith(`${SITE_ORIGIN}/`) ? url.slice(SITE_ORIGIN.length + 1) : null;
      if (file === null || !files.has(file)) r.failures.push(`a link names no file: ${url}`);
      else if (section !== "Tools") r.failures.push(`${url} is under ## ${section}, not ## Tools`);
      continue;
    }
    // The item lists its page even when the twin is missing, so one fault gives one failure.
    listed.push(path);
    const want = headingOf(path, groups);
    if (want === null) r.failures.push(`${path} has no group in the sidebar`);
    else if (want !== section) r.failures.push(`${path} is under ## ${section}, not ## ${want}`);
    if (files.has(url.slice(SITE_ORIGIN.length + 1))) r.counts.twins = (r.counts.twins ?? 0) + 1;
    else r.failures.push(`a link names no file: ${url}`);
    sections.set(section, [...(sections.get(section) ?? []), path]);
  }
  if (mcp === null) r.failures.push("llms.txt has no MCP server item");
  else if (mcp !== "Tools") r.failures.push(`the MCP server item is under ## ${mcp}, not ## Tools`);

  // The H2s: Tools, then each group in the sidebar order, then Optional.
  const h2s = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
  const expected = ["Tools"];
  for (const path of order) {
    const h = headingOf(path, groups);
    if (h !== null && h !== "Tools" && h !== "Optional" && !expected.includes(h)) expected.push(h);
  }
  if (order.some((path) => headingOf(path, groups) === "Optional")) expected.push("Optional");
  if (h2s.join() !== expected.join())
    r.failures.push(
      `llms.txt: the H2 order is ${h2s.join(", ")}; the sidebar gives ${expected.join(", ")}`,
    );

  // Both directions: each page of the tree once, and no twin of a page the tree lacks.
  const tree = pages.map((p) => pageUrl(p.path));
  for (const path of tree) {
    const n = listed.filter((x) => x === path).length;
    if (n === 0) r.failures.push(`${path} is not listed`);
    else if (n > 1) r.failures.push(`${path} is listed ${n} times`);
  }
  for (const path of new Set(listed))
    if (!tree.includes(path)) r.failures.push(`${path} is listed, but the content tree lacks it`);

  // Inside each section, the pages keep the sidebar order.
  for (const [name, paths] of sections) {
    const want = order.filter((p) => paths.includes(p));
    if (want.join() !== paths.join())
      r.failures.push(`llms.txt: the section ${name} does not keep the sidebar order`);
  }

  const full = fullText.split("\n");
  if (full.slice(0, 3).join("\n") !== lines.slice(0, 3).join("\n"))
    r.failures.push("llms-full.txt does not start with the H1 and the summary of llms.txt");
  const sources = [...fullText.matchAll(/^# .*\n\nSource: (\S+)$/gm)].map(
    (m) => pathOfTwin(m[1] ?? "") ?? m[1] ?? "",
  );
  // The first difference only: a full list of about one hundred pages hides it.
  const at = listed.findIndex((path, i) => sources[i] !== path);
  const first = at < 0 ? listed.length : at;
  if (first < Math.max(listed.length, sources.length))
    r.failures.push(
      `llms-full.txt holds the pages in another order than llms.txt: page ${first + 1} is ${listed[first] ?? "(none)"} in llms.txt and ${sources[first] ?? "(none)"} in llms-full.txt`,
    );
  return requireCounts(r, ["pages", "links", "twins"]);
}
