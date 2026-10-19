// The agent files that the site build writes from the agent index (plan 11e):
// the .md twin of each page, llms.txt, and llms-full.txt. The build script
// calls buildAgentFiles, and the tests and the checks import this file.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REMOTE_MCP_URL } from "@authtempo/cli";
import type { AgentIndex, AgentPage } from "@authtempo/mcp/index-format";
import { SITE_ORIGIN } from "./agent.ts";

/**
 * The sidebar groups that go under "## Optional" of llms.txt, in this order.
 * The llmstxt.org format marks with "Optional" the pages that an agent can
 * skip. The concept pages and the version pages explain, and no task needs them.
 */
export const OPTIONAL_GROUPS: readonly string[] = ["Concepts", "Versions"];

/**
 * The H2 of the pages at the top level of the sidebar (Home and FAQ). The
 * sidebar gives them no group label, and llms.txt needs an H2 for each list.
 */
export const TOP_LEVEL_SECTION = "Overview";

/** The page that "## Tools" lists after the MCP server line. Task 17 of plan 11e writes it. */
export const AGENTS_GUIDE = "/docs/guides/agents/";

const H1 = "# authtempo";
const SUMMARY =
  "> An auth engine for TypeScript on Workers, Node, and Bun. The docs are under https://authtempo.com/docs/.";
const INTRO =
  "These docs are the source of every fact about authtempo. This file lists every page, and /llms-full.txt holds the text of every page. An agent can also read the docs through the MCP server: run `authtempo mcp --claude-code` or another target in your project.";

/** The file of dist that holds the .md twin of a page, such as docs/start/index.md. */
export function twinFile(path: string): string {
  return `${path.slice(1)}index.md`;
}

/** The URL of the .md twin of a page. */
export function twinUrl(path: string): string {
  return `${SITE_ORIGIN}/${twinFile(path)}`;
}

/**
 * The sections of llms.txt in their order: the H2 and the pages of each.
 * The groups keep the sidebar order, and the optional groups come last.
 * It throws when an optional group has no page, so a renamed group fails
 * the build and does not move its pages in silence.
 */
export function llmsSections(
  index: AgentIndex,
  optional: readonly string[] = OPTIONAL_GROUPS,
): { heading: string; pages: AgentPage[] }[] {
  const groups = new Map<string, AgentPage[]>();
  for (const page of index.pages) {
    if (page.path === AGENTS_GUIDE) continue;
    const list = groups.get(page.group) ?? [];
    list.push(page);
    groups.set(page.group, list);
  }
  for (const g of optional)
    if (!groups.has(g)) throw new Error(`llms.txt: the optional group ${g} has no page`);
  const sections: { heading: string; pages: AgentPage[] }[] = [];
  for (const [group, pages] of groups)
    if (!optional.includes(group))
      sections.push({ heading: group === "" ? TOP_LEVEL_SECTION : group, pages });
  sections.push({ heading: "Optional", pages: optional.flatMap((g) => groups.get(g) ?? []) });
  return sections;
}

function item(name: string, url: string, notes: string): string {
  return `- [${name}](${url}): ${notes}`;
}

/** The text of llms.txt, in the order of llmstxt.org: the H1, the summary, the intro, and the H2 lists. */
export function llmsText(index: AgentIndex, optional: readonly string[] = OPTIONAL_GROUPS): string {
  const out = [H1, "", SUMMARY, "", INTRO, "", "## Tools", ""];
  out.push(
    item(
      "MCP server",
      REMOTE_MCP_URL,
      "the remote docs server, with the docs tools only and no sign-in.",
    ),
  );
  // The guide is listed here, and not again under its group, so each page has one line.
  const guide = index.pages.find((p) => p.path === AGENTS_GUIDE);
  if (guide) out.push(item(guide.title, twinUrl(guide.path), guide.description));
  // The OpenAPI document of plan 11g is a file of the build, not a page, so it has no twin.
  out.push(
    item(
      "OpenAPI document",
      `${SITE_ORIGIN}/docs/reference/openapi.json`,
      "the OpenAPI 3.1 document of every route, for an API client or a code generator.",
    ),
  );
  for (const s of llmsSections(index, optional)) {
    out.push("", `## ${s.heading}`, "");
    for (const p of s.pages) out.push(item(p.title, twinUrl(p.path), p.description));
  }
  return `${out.join("\n")}\n`;
}

/**
 * The text of llms-full.txt: the H1 and the summary of llms.txt, then the
 * agent markdown of each page in the order of llms.txt. Each page starts with
 * its one title line and its Source line.
 */
export function llmsFullText(
  index: AgentIndex,
  optional: readonly string[] = OPTIONAL_GROUPS,
): string {
  const guide = index.pages.filter((p) => p.path === AGENTS_GUIDE);
  const pages = [...guide, ...llmsSections(index, optional).flatMap((s) => s.pages)];
  const out = [H1, "", SUMMARY];
  for (const p of pages) {
    const title = `# ${p.title}\n`;
    // The agent markdown starts with the title line, so the page keeps one title line.
    if (!p.markdown.startsWith(title))
      throw new Error(`${p.path}: the agent markdown does not start with ${title.trim()}`);
    const rest = p.markdown.slice(title.length).replace(/^\n+/, "");
    out.push("", title.trim(), "", `Source: ${twinUrl(p.path)}`, "", rest.trimEnd());
  }
  return `${out.join("\n")}\n`;
}

/**
 * Writes the .md twin of each page, llms.txt, and llms-full.txt into `dist`
 * (a folder path with a trailing slash). It returns the number of twins.
 */
export function buildAgentFiles(
  index: AgentIndex,
  dist: string,
  optional: readonly string[] = OPTIONAL_GROUPS,
): { twins: number } {
  const llms = llmsText(index, optional);
  const full = llmsFullText(index, optional);
  let twins = 0;
  for (const p of index.pages) {
    const file = `${dist}${twinFile(p.path)}`;
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, p.markdown);
    twins += 1;
  }
  writeFileSync(`${dist}llms.txt`, llms);
  writeFileSync(`${dist}llms-full.txt`, full);
  return { twins };
}
