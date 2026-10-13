import { dirname, join } from "node:path";
import type { Page } from "./lib/markdown.ts";
import { DOCS, SITE } from "./lib/paths.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** A shell command, a JSON body, and an HTTP exchange may be inline. Code is a sample file. */
export const FENCE_LANGS = ["sh", "json", "jsonc", "http", "text"] as const;
const CODE_LANGS = new Set(["ts", "tsx", "js", "mjs", "javascript", "typescript"]);

/**
 * No page holds code inline, every `?raw` include names a file that exists,
 * and every sample file is included by a page, so no sample is dead code.
 */
export function checkFences(
  pages: readonly Page[],
  samples: readonly string[],
  exists: (absPath: string) => boolean,
): CheckReport {
  const r: CheckReport = {
    name: "check-fences",
    counts: { pages: pages.length, fences: 0, includes: 0, samples: samples.length },
    failures: [],
  };
  const included = new Set<string>();
  for (const p of pages) {
    let open = false;
    p.source.split("\n").forEach((line, i) => {
      const fence = /^\s*(```|~~~)(\S*)/.exec(line);
      if (!fence) return;
      if (open) {
        open = false;
        return;
      }
      open = true;
      r.counts.fences = (r.counts.fences ?? 0) + 1;
      const lang = fence[2] ?? "";
      if (CODE_LANGS.has(lang))
        r.failures.push(
          `${p.path}:${i + 1}: a ${lang} fence; a code sample is a file included with ?raw`,
        );
      else if (!(FENCE_LANGS as readonly string[]).includes(lang))
        r.failures.push(`${p.path}:${i + 1}: a fence must name one of ${FENCE_LANGS.join(", ")}`);
    });
    for (const m of p.source.matchAll(/^import\s+\w+\s+from\s+"([^"]+)\?raw";?$/gm)) {
      r.counts.includes = (r.counts.includes ?? 0) + 1;
      const abs = join(dirname(`${DOCS}${p.path}`), m[1] ?? "");
      included.add(abs);
      if (!abs.startsWith(`${SITE}samples/`)) {
        r.failures.push(`${p.path}: includes ${abs}, which is outside samples/`);
        continue;
      }
      if (!exists(abs)) r.failures.push(`${p.path}: includes ${abs}, which does not exist`);
    }
  }
  for (const s of samples)
    if (!included.has(s)) r.failures.push(`${s.slice(SITE.length)}: no page includes it`);
  return requireCounts(r, ["pages", "includes"]);
}
