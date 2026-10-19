import { inlineScripts, styleCounts } from "../check-csp.ts";
import { scriptHash } from "../check-script.ts";

/** The mark in public/_headers.template that the hash list replaces. */
export const HASHES_MARK = "{{SCRIPT_HASHES}}";
/** The marks of the style-src comment, which take the style counts of the build. */
export const STYLE_ELEMENTS_MARK = "{{STYLE_ELEMENTS}}";
export const STYLE_ATTRIBUTES_MARK = "{{STYLE_ATTRIBUTES}}";

/** The count of `mark` in `text`. */
function marks(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

/**
 * The _headers text of a build: the template with each distinct inline
 * script hash of the pages in place of the hash mark, quoted and sorted.
 * Sorted order makes two builds of one tree write the same file. The style
 * marks, when the template holds them, take the style counts of the pages.
 * It throws on a template without exactly one hash mark, and on a style
 * mark that occurs more than once. It also throws on a build with no inline
 * script.
 */
export function fillHeaders(template: string, pages: ReadonlyMap<string, string>): string {
  const hashMarks = marks(template, HASHES_MARK);
  if (hashMarks !== 1)
    throw new Error(`the template holds ${HASHES_MARK} ${hashMarks} times; it holds it once`);
  for (const mark of [STYLE_ELEMENTS_MARK, STYLE_ATTRIBUTES_MARK])
    if (marks(template, mark) > 1)
      throw new Error(
        `the template holds ${mark} ${marks(template, mark)} times; it holds it once at most`,
      );
  const hashes = new Set<string>();
  let elements = 0;
  let attributes = 0;
  for (const html of pages.values()) {
    for (const text of inlineScripts(html)) hashes.add(scriptHash(text));
    const styles = styleCounts(html);
    elements += styles.elements;
    attributes += styles.attributes;
  }
  if (hashes.size === 0) throw new Error("the build has no inline script; the writer read nothing");
  const list = [...hashes].sort().map((h) => `'${h}'`);
  return template
    .replace(HASHES_MARK, list.join(" "))
    .replace(STYLE_ELEMENTS_MARK, String(elements))
    .replace(STYLE_ATTRIBUTES_MARK, String(attributes));
}
