import { createHash } from "node:crypto";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** Brand spec 12: the toggle is under 30 lines. */
export const SCRIPT_MAX_LINES = 29;
/** What the toggle never does: no request, no loaded code, no written markup. */
export const SCRIPT_FORBIDDEN: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /sendBeacon/,
  /WebSocket/,
  /\bimport\b/,
  /https?:/,
  /\beval\s*\(/,
  /new\s+Function/,
  /document\.write/,
  /innerHTML/,
];

/** The CSP source of a script: `sha256-` and the base64 of the SHA-256 of its text. */
export function scriptHash(text: string): string {
  return `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/**
 * Brand spec 12 and the owner's decision of 2026-10-15: each root page holds
 * exactly one script, the inline theme toggle, with the SHA-256 of
 * src/scripts/theme-toggle.js. Any other script, inline or a file, fails.
 * The exemption line prints the hash for the CSP of plan 11b.
 */
export function checkScript(input: {
  toggle: string;
  rootPages: ReadonlyMap<string, string>;
}): CheckReport {
  const lines = input.toggle.trimEnd().split("\n").length;
  const allowed = scriptHash(input.toggle);
  const r: CheckReport = {
    name: "check-script",
    counts: { pages: input.rootPages.size, scripts: 0, lines },
    failures: [],
    exempt: [`src/scripts/theme-toggle.js ${allowed}: the theme toggle of brand spec 12`],
  };
  if (lines > SCRIPT_MAX_LINES)
    r.failures.push(`theme-toggle.js has ${lines} lines; the limit is ${SCRIPT_MAX_LINES}`);
  for (const re of SCRIPT_FORBIDDEN)
    if (re.test(input.toggle))
      r.failures.push(`theme-toggle.js matches ${re}; the toggle sends nothing and loads nothing`);
  for (const [page, html] of input.rootPages) {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    if (scripts.length !== 1)
      r.failures.push(
        `${page} has ${scripts.length} script elements; a root page has one, the theme toggle`,
      );
    for (const s of scripts) {
      r.counts.scripts = (r.counts.scripts ?? 0) + 1;
      const src = /\ssrc="([^"]*)"/.exec(s[1] ?? "")?.[1];
      if (src !== undefined)
        r.failures.push(`${page} loads the script file ${src}; a root page loads none`);
      else if (scriptHash(s[2] ?? "") !== allowed)
        r.failures.push(
          `${page} has an inline script ${scriptHash(s[2] ?? "")}, which is not the theme toggle`,
        );
    }
  }
  return requireCounts(r, ["pages", "scripts"]);
}
