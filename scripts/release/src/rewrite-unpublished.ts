import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAGE_NOTES,
  type PageNote,
  PRE_RELEASE_SENTENCES,
  type PreReleaseSentence,
  UNPUBLISHED_PAGES,
  VERSION_SLOT,
} from "../../../apps/site/src/data/unpublished.ts";
import { groupVersion } from "./lib/released.ts";
import { type Report, reportLines } from "./lib/report.ts";
import {
  noteForms,
  UNPUBLISHED_FILES,
  UNPUBLISHED_VERSION,
  type UnpublishedFile,
} from "./lib/unpublished.ts";

// The rewrite of the pre-release texts at the first release (ruling 50 of
// plan 12j, item 1). The version branch runs it after `changeset version`, in
// place of a hand edit. The dry run runs it in its release copy before the
// pack, when its source is at 0.0.0. It replaces each note of
// UNPUBLISHED_FILES, each note line of the pages of UNPUBLISHED_PAGES, and
// each text of PRE_RELEASE_SENTENCES with its published text, from the one
// list of each. A text that it cannot find fails, and so does a note form
// that is left after the rewrite. A run with a failure writes no file.
// check-pack, check-unpublished, and check-pre-release then hold the result.

/** The folder of the docs pages, from the repository root. */
export const DOCS_DIR = "apps/site/src/content/docs/";

/** The lists that the rewrite reads. Each test of a fixture tree gives its own. */
export interface RewriteLists {
  files: readonly UnpublishedFile[];
  /** UNPUBLISHED_PAGES: each page by its path under DOCS_DIR. */
  pages: readonly string[];
  pageNotes: readonly PageNote[];
  sentences: readonly PreReleaseSentence[];
}

/** The lists of the repository. */
export const REWRITE_LISTS: RewriteLists = {
  files: UNPUBLISHED_FILES,
  pages: UNPUBLISHED_PAGES,
  pageNotes: PAGE_NOTES,
  sentences: PRE_RELEASE_SENTENCES,
};

/**
 * Each file that the rewrite writes, by its path from the repository root.
 * check-changesets exempts these files on the version branch, which rewrites
 * them with no code change.
 */
export function rewrittenPaths(lists: RewriteLists = REWRITE_LISTS): string[] {
  return [
    ...new Set([
      ...lists.files.map((f) => f.path),
      ...lists.pages.map((page) => `${DOCS_DIR}${page}`),
      ...lists.sentences.filter((e) => e.published !== null).map((e) => e.file),
    ]),
  ].sort();
}

/** What the rewrite found, and the new text of each file that it changed. */
export interface RewriteResult extends Report {
  /** The new text of each file, by its path from the repository root. */
  texts: Map<string, string>;
}

/** The count of the places of `part` in `text`. */
const places = (text: string, part: string) => text.split(part).length - 1;

/** The first line of a text, for a failure line. */
const firstLine = (text: string) => text.split("\n")[0] ?? "";

/** The forms of a failure line, each in quotes. */
const quoted = (forms: readonly string[]) => forms.map((f) => `"${f}"`).join(", ");

/**
 * `source` without the paragraph `text` and the blank line after it, or null
 * when `text` is not a whole paragraph. A heading that the removal leaves
 * with no text before the next heading goes too, such as the section "The
 * versions today" of the versioning page.
 */
export function removeParagraph(source: string, text: string): string | null {
  const at = source.indexOf(text);
  if (at < 0) return null;
  let head = source.slice(0, at);
  const after = source.slice(at + text.length);
  if ((at !== 0 && !head.endsWith("\n\n")) || !after.startsWith("\n\n")) return null;
  const tail = after.slice(2);
  const heading = /(^|\n)#{1,6} [^\n]*\n\n$/.exec(head);
  if (heading !== null && (tail === "" || /^#{1,6} /.test(tail)))
    head = head.slice(0, heading.index + (heading[1] ?? "").length);
  return `${head}${tail}`;
}

/**
 * The rewrite of the files that `read` gives, at the group version
 * `version`. It writes nothing: the entry writes `texts`.
 */
export function rewriteUnpublished(
  read: (path: string) => string | null,
  version: string,
  lists: RewriteLists = REWRITE_LISTS,
): RewriteResult {
  const failures: string[] = [];
  const notes: string[] = [];
  const counts = { files: 0, notes: 0, pages: 0, lines: 0, texts: 0, hand: 0 };
  const texts = new Map<string, string>();
  const current = (path: string) => texts.get(path) ?? read(path);
  const result = { name: "rewrite-unpublished", counts, failures, notes, texts };
  if (version === UNPUBLISHED_VERSION || !/^\d+\.\d+\.\d+$/.test(version)) {
    failures.push(
      `the group is at ${version}; run the rewrite after changeset version, at the version of the release`,
    );
    return result;
  }
  const at = (published: string) => published.replaceAll(VERSION_SLOT, version);

  // The notes of the packed files.
  for (const file of lists.files) {
    let text = current(file.path);
    if (text === null) {
      failures.push(`${file.path} is in UNPUBLISHED_FILES and does not exist`);
      continue;
    }
    for (const n of file.notes) {
      const found = places(text, n.note);
      if (found !== 1) {
        failures.push(
          `${file.path} holds a note of UNPUBLISHED_FILES ${found} times, not once: ${firstLine(n.note)}`,
        );
        continue;
      }
      text = text.replace(n.note, () => at(n.published));
      counts.notes++;
    }
    texts.set(file.path, text);
    counts.files++;
  }

  // The note lines of the pages.
  for (const page of lists.pages) {
    const path = `${DOCS_DIR}${page}`;
    const source = current(path);
    if (source === null) {
      failures.push(`${path} is in UNPUBLISHED_PAGES and does not exist`);
      continue;
    }
    let replaced = 0;
    const lines = source.split("\n").map((line, i) => {
      const forms = noteForms(line);
      if (forms.length === 0) return line;
      const note = lists.pageNotes.find((n) => n.note === line);
      if (note === undefined) {
        failures.push(
          `${path}:${i + 1}: holds the note ${quoted(forms)}, and PAGE_NOTES lacks the line`,
        );
        return line;
      }
      replaced++;
      return at(note.published);
    });
    if (replaced === 0) {
      failures.push(`${path} is in UNPUBLISHED_PAGES and holds no line of PAGE_NOTES`);
      continue;
    }
    texts.set(path, lines.join("\n"));
    counts.pages++;
    counts.lines += replaced;
  }

  // The texts of PRE_RELEASE_SENTENCES. A text with no published form waits for its runbook step.
  for (const e of lists.sentences) {
    if (e.published === null) {
      counts.hand++;
      notes.push(`by hand: ${e.file}: ${firstLine(e.sentence)}`);
      continue;
    }
    const source = current(e.file);
    if (source === null) {
      failures.push(`${e.file} is in PRE_RELEASE_SENTENCES and does not exist`);
      continue;
    }
    const found = places(source, e.sentence);
    if (found !== 1) {
      failures.push(
        `${e.file} holds a text of PRE_RELEASE_SENTENCES ${found} times, not once: ${firstLine(e.sentence)}`,
      );
      continue;
    }
    const published = e.published;
    const next =
      published === ""
        ? removeParagraph(source, e.sentence)
        : source.replace(e.sentence, () => at(published));
    if (next === null) {
      failures.push(
        `${e.file}: the text is not a whole paragraph, so the rewrite cannot remove it: ${firstLine(e.sentence)}`,
      );
      continue;
    }
    texts.set(e.file, next);
    counts.texts++;
  }

  // No note form and no version slot stays in a file that the rewrite wrote.
  for (const [path, text] of texts) {
    const forms = noteForms(text);
    if (forms.length > 0)
      failures.push(
        `${path} still holds the note ${quoted(forms)} after the rewrite; its list lacks the text`,
      );
    if (text.includes(VERSION_SLOT))
      failures.push(`${path} still holds ${VERSION_SLOT} after the rewrite`);
  }
  return result;
}

/**
 * Runs the rewrite on the tree at `root`, at its group version. A run with a
 * failure writes no file, so a second run after a fix starts from the same tree.
 */
export function entry(
  root: string,
  lists: RewriteLists = REWRITE_LISTS,
): { lines: string[]; code: number } {
  let r: RewriteResult;
  try {
    const read = (path: string) =>
      existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
    r = rewriteUnpublished(read, groupVersion(root), lists);
  } catch (error) {
    r = {
      name: "rewrite-unpublished",
      counts: { files: 0, notes: 0, pages: 0, lines: 0, texts: 0, hand: 0 },
      failures: [error instanceof Error ? error.message : String(error)],
      notes: [],
      texts: new Map(),
    };
  }
  if (r.failures.length === 0)
    for (const [path, text] of r.texts) writeFileSync(join(root, path), text);
  return { lines: reportLines(r), code: r.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = entry(fileURLToPath(new URL("../../../", import.meta.url)));
  for (const line of lines) console.log(line);
  process.exit(code);
}
