import { dirname, posix } from "node:path";
import { type AgentIndex, parseAgentIndex } from "@authtempo/mcp/index-format";
import { pageUrl } from "./check-frontmatter.ts";
import type { ReadFile } from "./lib/agent.ts";
import { idsOf } from "./lib/html.ts";
import type { Page } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * The languages where the "// <title>" line of an include fence is a comment.
 * The build writes that line for each include with a title (review I-5 of
 * Task 3). Each other language with a title fails here.
 */
export const TITLE_LANGS: readonly string[] = ["ts", "tsx", "jsonc"];

/** One sample include of a page, as its source names it. */
export interface SampleInclude {
  /** The URL path of the page. */
  path: string;
  /** The file, by its path from the folder of the page sources. */
  file: string;
  lang: string;
  title: string | null;
  /** The text of the file now, or null when it does not exist. */
  text: string | null;
}

/**
 * Every sample include of the page sources, found again from the sources.
 * The index marks no include fence (review I-4 of Task 3). A check that used
 * the build's own parser would agree with the build when both are wrong.
 */
export function sampleIncludes(pages: readonly Page[], readFile: ReadFile): SampleInclude[] {
  const out: SampleInclude[] = [];
  for (const p of pages) {
    const imports = new Map(
      [...p.source.matchAll(/^import\s+(\w+)\s+from\s+"([^"]+)\?raw";?\s*$/gm)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    );
    for (const m of p.source.matchAll(/^<Code\s([^>]*?)\s*\/>\s*$/gm)) {
      const attrs = m[1] ?? "";
      const target = imports.get(/\bcode=\{(\w+)\}/.exec(attrs)?.[1] ?? "");
      if (target === undefined) continue;
      const file = posix.normalize(posix.join(dirname(p.path), target));
      let text: string | null;
      try {
        text = readFile(file);
      } catch {
        text = null;
      }
      out.push({
        path: pageUrl(p.path),
        file,
        lang: /\blang="([^"]*)"/.exec(attrs)?.[1] ?? "",
        title: /\btitle="([^"]*)"/.exec(attrs)?.[1] ?? null,
        text,
      });
    }
  }
  return out;
}

/** The body of each fence of a markdown text, by its language. */
function fencesOf(markdown: string): { lang: string; body: string }[] {
  const out: { lang: string; body: string }[] = [];
  let open: { marks: string; lang: string; lines: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    if (open === null) {
      const f = /^(`{3,}|~{3,})(\S*)\s*$/.exec(line);
      if (f) open = { marks: f[1] ?? "```", lang: f[2] ?? "", lines: [] };
    } else if (line === open.marks) {
      out.push({ lang: open.lang, body: `${open.lines.join("\n")}\n` });
      open = null;
    } else open.lines.push(line);
  }
  return out;
}

/** The ids of the h2 and h3 headings of a built page, in order, without the page contents heading of Starlight. */
function headingIds(html: string): string[] {
  return [...html.matchAll(/<h[23]\b[^>]*\sid="([^"]+)"/g)]
    .map((m) => m[1] ?? "")
    .filter((id) => !id.startsWith("starlight__"));
}

/**
 * The agent index keeps its format and holds every page of the content tree
 * and no other. Each anchor is on the built page, in the order of its
 * headings. Each sample include is a fence with the sample's text now.
 * `distPages` maps each HTML file of dist, such as docs/start/index.html, to its text.
 */
export function checkAgentIndex(
  indexText: string,
  pages: readonly Page[],
  distPages: ReadonlyMap<string, string>,
  samples: readonly SampleInclude[],
): CheckReport {
  const r: CheckReport = {
    name: "check-agent-index",
    counts: { pages: 0, sections: 0, samples: 0 },
    failures: [],
  };
  // The parser also holds the header counts to the array lengths.
  let index: AgentIndex;
  try {
    index = parseAgentIndex(indexText);
  } catch (e) {
    r.failures.push((e as Error).message);
    return requireCounts(r, ["pages", "sections", "samples"]);
  }
  r.counts.pages = index.pages.length;

  // Both directions: a page of the tree that the index lacks, and a page of the index that the tree lacks.
  const tree = pages.map((p) => pageUrl(p.path));
  const held = index.pages.map((p) => p.path);
  for (const path of tree) if (!held.includes(path)) r.failures.push(`the index lacks ${path}`);
  for (const path of held)
    if (!tree.includes(path))
      r.failures.push(`the content tree lacks ${path}, which the index holds`);

  for (const page of index.pages) {
    const sections = index.sections.filter((s) => s.path === page.path && s.anchor !== null);
    r.counts.sections = (r.counts.sections ?? 0) + sections.length;
    const html = distPages.get(`${page.path.slice(1)}index.html`);
    if (html === undefined) {
      r.failures.push(`${page.path}: the build has no page`);
      continue;
    }
    const ids = idsOf(html);
    const missing = sections.filter((s) => !ids.has(s.anchor ?? ""));
    for (const s of missing)
      r.failures.push(`${page.path}#${s.anchor}: the built page has no such id`);
    if (missing.length > 0) continue;
    // An existence check misses a repeat heading with the wrong id. The order compare finds it.
    const anchors = sections.map((s) => s.anchor ?? "");
    const headings = headingIds(html);
    if (anchors.join() !== headings.join())
      r.failures.push(
        `${page.path}: the anchors differ from the headings of the built page: ${anchors.join(", ")} in the index; ${headings.join(", ")} on the page`,
      );
  }

  for (const s of samples) {
    const page = index.pages.find((p) => p.path === s.path);
    if (!page) continue;
    r.counts.samples = (r.counts.samples ?? 0) + 1;
    if (s.text === null) {
      r.failures.push(`${s.path}: the sample ${s.file} does not exist`);
      continue;
    }
    if (s.title !== null && !TITLE_LANGS.includes(s.lang)) {
      r.failures.push(
        `${s.path}: the sample ${s.file} has a title, and its // line is no comment in ${s.lang} (the title line suits ${TITLE_LANGS.join(", ")})`,
      );
      continue;
    }
    const text = s.text.endsWith("\n") ? s.text : `${s.text}\n`;
    const body = s.title === null ? text : `// ${s.title}\n${text}`;
    if (!fencesOf(page.markdown).some((f) => f.lang === s.lang && f.body === body))
      r.failures.push(`${s.path}: no ${s.lang} fence holds the text of ${s.file}`);
  }
  return requireCounts(r, ["pages", "sections", "samples"]);
}
