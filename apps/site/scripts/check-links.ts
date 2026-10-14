import { hrefsOf, idsOf } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The file of dist that an internal href names, and its fragment. Null for an external href. */
function targetOf(from: string, href: string): { file: string; fragment: string | null } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const hash = href.indexOf("#");
  const before = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? null : decodeURIComponent(href.slice(hash + 1));
  const pathPart = before.split("?")[0] ?? "";
  const url =
    pathPart === "" ? `/${from}` : new URL(pathPart, `https://site.invalid/${from}`).pathname;
  let file = decodeURIComponent(url.endsWith("/") ? `${url.slice(1)}index.html` : url.slice(1));
  if (!/\.[a-z0-9]+$/i.test(file)) file = `${file}/index.html`;
  return { file, fragment };
}

/**
 * Every internal href of every page of the build names a file of the build,
 * and every fragment names an element id of that page. Our own script on the
 * build output, with no link-check supplier.
 */
export function checkLinks(
  pages: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
): CheckReport {
  const r: CheckReport = {
    name: "check-links",
    counts: { pages: pages.size, links: 0, anchors: 0, external: 0 },
    failures: [],
  };
  const ids = new Map<string, Set<string>>();
  for (const [path, html] of pages) ids.set(path, idsOf(html));
  for (const [from, html] of pages) {
    for (const href of hrefsOf(html)) {
      const target = targetOf(from, href);
      if (target === null) {
        r.counts.external = (r.counts.external ?? 0) + 1;
        continue;
      }
      r.counts.links = (r.counts.links ?? 0) + 1;
      // The Worker's assets send /x to /x/ only by a redirect, so every
      // internal page link names the folder form (astro.config.mjs).
      const last = href.split(/[?#]/)[0]?.split("/").pop() ?? "";
      if (last !== "" && !/\.[a-z0-9]+$/i.test(last)) {
        r.failures.push(
          `${from}: ${href} is a page link with no trailing /; every internal page link ends with /`,
        );
        continue;
      }
      if (!files.has(target.file)) {
        r.failures.push(`${from}: ${href} has no file ${target.file}`);
        continue;
      }
      if (target.fragment === null || target.fragment === "") continue;
      r.counts.anchors = (r.counts.anchors ?? 0) + 1;
      if (!ids.get(target.file)?.has(target.fragment))
        r.failures.push(
          `${from}: ${href} has no element with id ${target.fragment} in ${target.file}`,
        );
    }
  }
  return requireCounts(r, ["pages", "links"]);
}
