// The agent files of the site build (plan 11e). `astro build` writes dist;
// this step then writes dist/agent/index.json from the page sources, in the
// sidebar order of the built home page. It validates the index with the
// format's own parser before the write, so the server never loads a file
// that its parser refuses. From the index it writes the .md twin of each
// page, llms.txt, and llms-full.txt. It runs before the checks, which read its output.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTE_MCP_URL } from "@authtempo/cli";
import { type AgentIndex, type AgentPage, parseAgentIndex } from "@authtempo/mcp/index-format";
import { FORBIDDEN_TERMS } from "./check-terms.ts";
import {
  bindingsOf,
  buildAgentIndex,
  SITE_ORIGIN,
  sidebarGroups,
  sidebarOrder,
  termsOf,
} from "./lib/agent.ts";
import { EXPORT_ENTRIES, SDK_PACKAGES } from "./lib/entries.ts";
import { docsPages } from "./lib/load.ts";
import { DIST, DOCS, REPO } from "./lib/paths.ts";

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

/** The commit of the tree, or "unknown" when the tree has no git. */
function commitOf(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main(): void {
  const home = readFileSync(`${DIST}docs/index.html`, "utf8");
  const index = buildAgentIndex(docsPages(), sidebarOrder(home), {
    commit: commitOf(),
    readFile: (path) => readFileSync(resolve(DOCS, path), "utf8"),
    terms: termsOf(FORBIDDEN_TERMS),
    bindings: bindingsOf(EXPORT_ENTRIES, SDK_PACKAGES),
    groups: sidebarGroups(home),
  });
  const text = `${JSON.stringify(index, null, 2)}\n`;
  parseAgentIndex(text);

  const { pages, sections } = index.header;
  if (pages === 0 || sections === 0) {
    console.error(`build-agent: FAIL pages=${pages} sections=${sections}`);
    process.exit(1);
  }
  mkdirSync(`${DIST}agent/`, { recursive: true });
  writeFileSync(`${DIST}agent/index.json`, text);
  const { twins } = buildAgentFiles(index, DIST);
  console.log(`build-agent: PASS pages=${pages} sections=${sections} twins=${twins}`);
}

// The tests import buildAgentFiles, so the build runs only when node runs this file.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
