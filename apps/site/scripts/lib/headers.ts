import { inlineScripts } from "../check-csp.ts";
import { scriptHash } from "../check-script.ts";

/** The mark in public/_headers.template that the hash list replaces. */
export const HASHES_MARK = "{{SCRIPT_HASHES}}";

/**
 * The _headers text of a build: the template with each distinct inline
 * script hash of the pages in place of the mark, quoted and sorted. Sorted
 * order makes two builds of one tree write the same file. It throws on a
 * template without exactly one mark, and on a build with no inline script.
 */
export function fillHeaders(template: string, pages: ReadonlyMap<string, string>): string {
  const marks = template.split(HASHES_MARK).length - 1;
  if (marks !== 1)
    throw new Error(`the template holds ${HASHES_MARK} ${marks} times; it holds it once`);
  const hashes = new Set<string>();
  for (const html of pages.values())
    for (const text of inlineScripts(html)) hashes.add(scriptHash(text));
  if (hashes.size === 0) throw new Error("the build has no inline script; the writer read nothing");
  const list = [...hashes].sort().map((h) => `'${h}'`);
  return template.replace(HASHES_MARK, list.join(" "));
}
