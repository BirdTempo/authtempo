import { dirname, posix } from "node:path";
import type { AgentIndex, AgentPage, AgentSection } from "@authtempo/mcp/index-format";
import { pageUrl } from "../check-frontmatter.ts";
import type { ExportEntry } from "./entries.ts";
import { type Page, parseFrontmatter } from "./markdown.ts";

/** The origin of the published site. A `/docs/` link in the agent markdown starts with it. */
export const SITE_ORIGIN = "https://authtempo.com";
/** The folder of the page sources, from the repo root. */
export const BUILT_FROM = "apps/site/src/content/docs/docs/";
/** No release exists yet, so the index has one version (spec 18 item 13). */
export const VERSIONS = ["latest"];

/**
 * Reads a file by its path relative to the folder of the page paths
 * (src/content/docs/ on the real tree). It throws when the file is missing.
 */
export type ReadFile = (path: string) => string;

const FENCE = /^\s*(`{3,}|~{3,})/;
const RAW_IMPORT = /^import\s+(\w+)\s+from\s+"([^"]+)\?raw";?\s*$/;
const CODE_TAG = /^\s*<Code\s([^>]*?)\s*\/>\s*$/;
const RAW_H3 = /^<h3 id="([^"]+)">(.*)<\/h3>\s*$/;

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text of an HTML fragment: each tag goes, and the entities decode. */
function textOf(html: string): string {
  return decode(html.replace(/<[^>]+>/g, "")).trim();
}

function attr(attrs: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

/** A fence that is longer than every backtick run of the text, so the text cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * One prose line with the markup of a page made plain: an autolink keeps its
 * URL, each HTML and MDX element goes and its text stays, and each `/docs/`
 * link becomes absolute. A code span stays as it is, because its text is code.
 */
function plainLine(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return part;
      let out = part
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/<(https?:[^>\s]+)>/g, "$1")
        .replace(/<\/?[A-Za-z][^>]*>/g, "");
      out = out.replace(/\]\(\/docs\//g, `](${SITE_ORIGIN}/docs/`);
      return out;
    })
    .join("");
}

/**
 * The agent markdown of a page: `# <title>`, the description, and the body
 * with each sample include as a fence, each raw h3 anchor as a heading with
 * its id, every other element as its text, and each `/docs/` link absolute.
 * Tables, headings, lists, and fences stay as they are.
 */
export function agentMarkdown(page: Page, readFile: ReadFile): string {
  const fm = parseFrontmatter(page.source);
  if (!fm) throw new Error(`${page.path}: the page has no frontmatter`);
  const title = fm.fields.title ?? "";
  const description = fm.fields.description ?? "";
  const imports = new Map<string, string>();
  for (const m of fm.body.matchAll(new RegExp(RAW_IMPORT.source, "gm")))
    imports.set(m[1] ?? "", m[2] ?? "");

  const out: string[] = [`# ${title}`, "", description, ""];
  let fence: string | null = null;
  for (const line of fm.body.split("\n")) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      out.push(line);
      if (f?.[1]?.startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1] ?? "```";
      out.push(line);
      continue;
    }
    if (/^import\s/.test(line)) continue;
    const code = CODE_TAG.exec(line);
    if (code) {
      out.push(...includeFence(page, code[1] ?? "", imports, readFile));
      continue;
    }
    const h3 = RAW_H3.exec(line);
    if (h3) {
      out.push(`### ${textOf(h3[2] ?? "")} {#${h3[1]}}`);
      continue;
    }
    out.push(plainLine(line));
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

function includeFence(
  page: Page,
  attrs: string,
  imports: ReadonlyMap<string, string>,
  readFile: ReadFile,
): string[] {
  const name = /\bcode=\{(\w+)\}/.exec(attrs)?.[1] ?? "";
  const target = imports.get(name);
  if (target === undefined)
    throw new Error(`${page.path}: the include ${name || "(no name)"} has no ?raw import`);
  const path = posix.normalize(posix.join(dirname(page.path), target));
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw new Error(`${page.path}: the include ${name} names ${target}, which does not exist`);
  }
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const marks = fenceFor(body);
  const title = attr(attrs, "title");
  const lines = [`${marks}${attr(attrs, "lang") ?? ""}`];
  if (title !== null) lines.push(`// ${title}`);
  return [...lines, ...body.slice(0, -1).split("\n"), marks];
}

/**
 * The `/docs/` hrefs of the sidebar nav of a built page, in document order,
 * with no duplicate. A link outside the sidebar nav does not count.
 */
export function sidebarOrder(html: string): string[] {
  const nav = sidebarNav(html);
  const out: string[] = [];
  for (const m of nav.matchAll(/<a\s[^>]*href="(\/docs\/[^"#?]*)"/g)) {
    const href = m[1] ?? "";
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

/**
 * The label of the top-level sidebar group of each `/docs/` href. A link at
 * the top level of the sidebar has no group, so it maps to "".
 */
export function sidebarGroups(html: string): Record<string, string> {
  const nav = sidebarNav(html);
  const groups: Record<string, string> = {};
  let depth = 0;
  let group = "";
  const token =
    /<details\b[^>]*>|<\/details>|<span class="group-label[^"]*">\s*<span[^>]*>([^<]*)<\/span>|<a\s[^>]*href="(\/docs\/[^"#?]*)"/g;
  for (const m of nav.matchAll(token)) {
    const t = m[0];
    if (t.startsWith("<details")) depth += 1;
    else if (t === "</details>") depth -= 1;
    else if (m[1] !== undefined) {
      if (depth === 1) group = decode(m[1].trim());
    } else if (m[2] !== undefined && !(m[2] in groups)) groups[m[2]] = depth === 0 ? "" : group;
  }
  return groups;
}

function sidebarNav(html: string): string {
  const start = /<nav\b[^>]*class="sidebar\b[^"]*"[^>]*>/.exec(html);
  if (!start) throw new Error("the built page has no sidebar nav");
  const end = html.indexOf("</nav>", start.index);
  return html.slice(start.index, end < 0 ? html.length : end);
}

/** The heading text as a reader sees it: code marks, emphasis, and link targets go. */
function headingText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .trim();
}

/**
 * The id that the site build gives a markdown heading: github-slugger, the
 * slugger of Astro's heading ids. A repeat gains -1, -2, and so on.
 */
function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    let n = seen.get(base) ?? 0;
    while (seen.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    seen.set(base, n);
    seen.set(slug, 0);
    return slug;
  };
}

/** Every `##` and `###` section of an agent markdown, in order. */
export function sectionsOf(path: string, markdown: string): AgentSection[] {
  const sections: AgentSection[] = [];
  const slug = slugger();
  let fence: string | null = null;
  let current: { section: AgentSection; lines: string[] } | null = null;
  const flush = () => {
    if (current) sections.push({ ...current.section, text: current.lines.join("\n").trim() });
    current = null;
  };
  for (const line of markdown.split("\n")) {
    const f = FENCE.exec(line);
    if (fence !== null || f) {
      if (fence === null && f) fence = f[1] ?? "```";
      else if (fence !== null && f?.[1]?.startsWith(fence)) fence = null;
      current?.lines.push(line);
      continue;
    }
    const h = /^(#{2,6}) (.*?)(?: \{#([^}]+)\})?\s*$/.exec(line);
    if (!h) {
      current?.lines.push(line);
      continue;
    }
    const depth = (h[1] ?? "").length;
    const heading = headingText(h[2] ?? "");
    // An explicit id is the build's id; any other heading takes the slugger's.
    const anchor = h[3] ?? slug(heading);
    if (depth > 3) {
      current?.lines.push(line);
      continue;
    }
    flush();
    current = { section: { path, heading, anchor, depth: depth as 2 | 3, text: "" }, lines: [] };
  }
  flush();
  return sections;
}

/** The `/docs/` link targets of an agent markdown, in order, with no duplicate. */
function linksOf(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/\]\(https:\/\/authtempo\.com(\/docs\/[^)\s]*)\)/g)) {
    const link = m[1] ?? "";
    if (!out.includes(link)) out.push(link);
  }
  return out;
}

/** Each forbidden word, in lower case, to its approved term. */
export function termsOf(terms: readonly { term: string; use: string }[]): Record<string, string> {
  return Object.fromEntries(terms.map((t) => [t.term.toLowerCase(), t.use]));
}

/**
 * The packages of the SDK that are no binding. The client runs in the
 * browser, verify checks a caller in any server, handoff passes a sign-in to
 * a native app, and core is the engine that each binding wraps.
 */
const NOT_BINDINGS = new Set([
  "@authtempo/core",
  "@authtempo/client",
  "@authtempo/verify",
  "@authtempo/handoff",
]);

/** Each export entry of a binding package, by its label, with its page. */
export function bindingsOf(
  entries: readonly ExportEntry[],
  sdkPackages: readonly string[],
): { name: string; page: string }[] {
  return entries
    .filter((e) => sdkPackages.includes(e.pkg) && !NOT_BINDINGS.has(e.pkg))
    .map((e) => ({ name: e.label, page: e.page }));
}

export interface BuildOptions {
  commit: string;
  readFile: ReadFile;
  terms: Record<string, string>;
  bindings: { name: string; page: string }[];
  /** The sidebar group of each URL path (`sidebarGroups`). */
  groups: Readonly<Record<string, string>>;
}

/**
 * The agent index of a content tree: one entry per page in the sidebar
 * order, and one per `##` and `###` section. It throws on a page that the
 * sidebar does not list and on a sidebar link that has no page, so the index
 * and the site hold the same pages.
 */
export function buildAgentIndex(
  pages: readonly Page[],
  order: readonly string[],
  options: BuildOptions,
): AgentIndex {
  const byPath = new Map(pages.map((p) => [pageUrl(p.path), p]));
  const failures: string[] = [];
  for (const path of byPath.keys())
    if (!order.includes(path)) failures.push(`${path}: the sidebar does not list the page`);
  for (const path of order)
    if (!byPath.has(path)) failures.push(`${path}: the sidebar links a page that does not exist`);
  if (failures.length > 0) throw new Error(failures.join("\n"));

  const agentPages: AgentPage[] = [];
  const sections: AgentSection[] = [];
  for (const path of order) {
    const page = byPath.get(path);
    if (!page) continue;
    const fm = parseFrontmatter(page.source);
    const markdown = agentMarkdown(page, options.readFile);
    agentPages.push({
      path,
      title: fm?.fields.title ?? "",
      description: fm?.fields.description ?? "",
      type: (fm?.fields.type ?? "") as AgentPage["type"],
      group: options.groups[path] ?? "",
      sources: fm?.lists.sources ?? [],
      markdown,
      links: linksOf(markdown),
    });
    sections.push(...sectionsOf(path, markdown));
  }
  return {
    header: {
      format: 1,
      commit: options.commit,
      builtFrom: BUILT_FROM,
      pages: agentPages.length,
      sections: sections.length,
      versions: [...VERSIONS],
      terms: options.terms,
      bindings: options.bindings,
    },
    pages: agentPages,
    sections,
  };
}
