import { SITE } from "../src/data/site.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * Plan 11b: a root page and the CSS and script files it links weigh at most
 * 64 KiB before compression. check-size keeps the file and byte limits of
 * the whole build; this limit is what one reader of a root page loads.
 */
export const WEIGHT_MAX = 65_536;

/** The same-origin path of a URL, without its query and fragment, or null for another origin. */
function sameOriginPath(url: string): string | null {
  const u = url.trim();
  let path: string;
  if (u.startsWith("/") && !u.startsWith("//")) path = u;
  else if (u.startsWith(`${SITE.origin}/`)) path = u.slice(SITE.origin.length);
  else return null;
  return path.split(/[?#]/)[0] ?? path;
}

/** Each same-origin CSS and script file that a page links, once each, in document order. */
function linkedFiles(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<(link|script)\b[^>]*>/gi)) {
    const tag = m[0];
    let url: string | undefined;
    if ((m[1] ?? "").toLowerCase() === "script") url = /\ssrc="([^"]*)"/i.exec(tag)?.[1];
    else if (/\srel="(?:stylesheet|modulepreload)"/i.test(tag))
      url = /\shref="([^"]*)"/i.exec(tag)?.[1];
    const path = url === undefined ? null : sameOriginPath(url);
    if (path !== null) out.add(path);
  }
  return [...out];
}

/**
 * The weight of each root page: its own bytes plus the bytes of each
 * same-origin CSS and script file it links. `assetBytes` gives the size of a
 * file of the build by its URL path, or null when the build lacks it.
 */
export function checkWeight(
  root: ReadonlyMap<string, string>,
  assetBytes: (path: string) => number | null,
): CheckReport {
  const r: CheckReport = {
    name: "check-weight",
    counts: { pages: root.size, largest_bytes: 0 },
    failures: [],
  };
  for (const [page, html] of root) {
    let bytes = Buffer.byteLength(html, "utf8");
    for (const path of linkedFiles(html)) {
      const size = assetBytes(path);
      if (size === null) r.failures.push(`${page} links ${path}, which the build lacks`);
      else bytes += size;
    }
    r.counts.largest_bytes = Math.max(r.counts.largest_bytes ?? 0, bytes);
    if (bytes > WEIGHT_MAX)
      r.failures.push(`${page} weighs ${bytes} bytes; the limit is ${WEIGHT_MAX}`);
  }
  return requireCounts(r, ["pages"]);
}
