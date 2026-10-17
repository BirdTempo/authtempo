import { REMOTE_MCP_URL } from "@authtempo/cli";
import { pageUrl } from "./check-frontmatter.ts";
import { SITE_ORIGIN } from "./lib/agent.ts";
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
 * llms.txt keeps the llmstxt.org form, and lists every page of the content
 * tree once by its .md twin, which the build wrote. llms-full.txt holds the
 * same pages in the same order. `files` are the paths of dist, `order` is
 * the sidebar order of the URL paths.
 */
export function checkLlms(
  files: ReadonlySet<string>,
  llmsText: string,
  fullText: string,
  pages: readonly Page[],
  order: readonly string[],
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
  let mcp = false;
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
      mcp = true;
      r.exempt?.push(`${url}: the remote MCP server is a planned address, not a file of the build`);
      continue;
    }
    const path = pathOfTwin(url);
    if (path === null) {
      r.failures.push(`a link names no file: ${url}`);
      continue;
    }
    // The item lists its page even when the twin is missing, so one fault gives one failure.
    listed.push(path);
    if (files.has(url.slice(SITE_ORIGIN.length + 1))) r.counts.twins = (r.counts.twins ?? 0) + 1;
    else r.failures.push(`a link names no file: ${url}`);
    sections.set(section, [...(sections.get(section) ?? []), path]);
  }
  if (!mcp) r.failures.push("llms.txt has no MCP server item");

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
