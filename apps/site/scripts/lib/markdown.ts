/** A page source. `path` is relative to src/content/docs/, such as docs/guides/magic-link.mdx. */
export interface Page {
  path: string;
  source: string;
}

export interface Frontmatter {
  /** `key: value` lines. */
  fields: Record<string, string>;
  /** `key:` lines followed by `  - item` lines. */
  lists: Record<string, string[]>;
  body: string;
  /** The line number of the first body line in the source, from 1. */
  bodyLine: number;
}

function unquote(v: string): string {
  const q = v[0];
  return (q === '"' || q === "'") && v.length > 1 && v.endsWith(q) ? v.slice(1, -1) : v;
}

/**
 * The frontmatter subset that the pages of plan 11a use: one-line values,
 * lists of one-line items, and nested maps (such as `sidebar:` with
 * `  order: 2`), which it skips. Null when the source has no frontmatter.
 */
export function parseFrontmatter(source: string): Frontmatter | null {
  const lines = source.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey: string | null = null;
  for (const line of lines.slice(1, end)) {
    const item = /^ {2}- (.*)$/.exec(line);
    if (item && listKey !== null) {
      const items = lists[listKey] ?? [];
      items.push(unquote(item[1] ?? ""));
      lists[listKey] = items;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const value = kv[2] ?? "";
    if (value === "") {
      listKey = key;
    } else {
      listKey = null;
      fields[key] = unquote(value);
    }
  }
  return { fields, lists, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}

export interface ProseUnit {
  /** "step" for an item of a numbered list, else "text". */
  kind: "step" | "text";
  text: string;
  /** The source line where the unit starts. */
  line: number;
}

/**
 * The prose of a page body, one unit per paragraph or list item. Markup holds
 * no prose and is skipped: a code fence, a table row, a heading, a raw HTML or
 * JSX line, an MDX import or export, and an aside fence (`:::`). A unit runs
 * until a blank line or a markup line.
 */
export function proseUnits(body: string, firstLine: number): ProseUnit[] {
  const units: ProseUnit[] = [];
  let fence = false;
  let current: ProseUnit | null = null;
  const flush = () => {
    if (current && current.text.trim() !== "") units.push(current);
    current = null;
  };
  body.split("\n").forEach((raw, i) => {
    const line = firstLine + i;
    const t = raw.trim();
    if (/^(```|~~~)/.test(t)) {
      flush();
      fence = !fence;
      return;
    }
    if (fence) return;
    if (t === "" || /^(\||#|<|import\s|export\s|:::)/.test(t)) {
      flush();
      return;
    }
    const step = /^\d+\.\s+(.*)$/.exec(t);
    const item = /^[-*]\s+(.*)$/.exec(t);
    if (step || item) {
      flush();
      current = { kind: step ? "step" : "text", text: (step ?? item)?.[1] ?? "", line };
      return;
    }
    if (current) current.text += ` ${t}`;
    else current = { kind: "text", text: t, line };
  });
  flush();
  return units;
}

/**
 * The words of a unit as a reader counts them: a code span is one word, a
 * link is its label, and emphasis marks and HTML tags go.
 */
export function plainText(text: string): string {
  return text
    .replace(/`[^`]*`/g, "CODE")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences end at `.`, `!`, or `?` before a space. The pages use no abbreviation with a period. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A word holds at least one letter or digit, so a dash or an arrow is no word. */
export function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
