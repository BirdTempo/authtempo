import { scriptHash } from "./check-script.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** A script of these types is data, not code, so the CSP needs no hash for it. */
const DATA_TYPES: readonly string[] = ["application/json", "application/ld+json"];

/**
 * The Workers static assets headers page (last updated 2026-09-22, read
 * 2026-10-19) allows 2,000 characters on one line of _headers. Each new
 * inline script adds about 55 characters to the CSP line.
 */
export const HEADERS_LINE_MAX = 2000;

/**
 * The directives whose value is fixed (plan 11b design and Task 3). The
 * script-src and style-src rules follow below; they depend on the build.
 */
const FIXED: readonly [directive: string, value: string][] = [
  ["default-src", "'self'"],
  ["frame-ancestors", "'none'"],
  ["form-action", "'self'"],
  ["base-uri", "'self'"],
  ["object-src", "'none'"],
  // Ruling 12 of the plan 11b lane: Starlight, Expressive Code, and Pagefind
  // draw icons as data: images in CSS. A data: image sends no request.
  ["img-src", "'self' data:"],
];

/** The first line of the count comment that `'unsafe-inline'` in style-src needs (plan 11b deviation 7). */
const STYLE_COMMENT =
  /^# style-src: \d+ style elements and \d+ style attributes in the build of \d{4}-\d{2}-\d{2}\./m;

/**
 * The text of each inline script of a page: a script with no `src`, of any
 * type but JSON. A browser runs each one, a module too, so each needs a hash.
 */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = (type?.[1] ?? type?.[2] ?? type?.[3] ?? "").trim().toLowerCase();
    if (DATA_TYPES.includes(value)) continue;
    out.push(m[2] ?? "");
  }
  return out;
}

/** Each `Content-Security-Policy` line of a _headers file, with the URL rule above it. */
function policyLines(headers: string): { rule: string; value: string }[] {
  const out: { rule: string; value: string }[] = [];
  let rule = "";
  for (const line of headers.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rule = line.trim();
      continue;
    }
    const m = /^\s+Content-Security-Policy:\s*(.*)$/i.exec(line);
    if (m) out.push({ rule, value: (m[1] ?? "").trim() });
  }
  return out;
}

/** The directives of a policy by name, each with its sources. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/**
 * The CSP of dist/_headers against the build (plan 11b Task 3). The rule for
 * /* holds the one policy. Its script-src is 'self', 'wasm-unsafe-eval', and
 * one hash for each distinct inline script of the build, and no other hash.
 * write-headers.ts writes the hashes; this check reads the build again.
 */
export function checkCsp(pages: ReadonlyMap<string, string>, headers: string | null): CheckReport {
  const r: CheckReport = {
    name: "check-csp",
    counts: { pages: pages.size, inline_scripts: 0, hashes: 0 },
    failures: [],
  };
  if (headers === null) {
    r.failures.push("dist/_headers is missing");
    return r;
  }

  const built = new Map<string, string>();
  let styleElements = 0;
  let styleAttributes = 0;
  for (const [page, html] of pages) {
    for (const text of inlineScripts(html)) {
      const hash = scriptHash(text);
      if (!built.has(hash)) built.set(hash, page);
    }
    styleElements += [...html.matchAll(/<style\b/gi)].length;
    styleAttributes += [...html.matchAll(/\sstyle\s*=/gi)].length;
  }
  r.counts.inline_scripts = built.size;

  headers.split("\n").forEach((line, i) => {
    if (line.length > HEADERS_LINE_MAX)
      r.failures.push(
        `_headers line ${i + 1} has ${line.length} characters; the platform limit is ${HEADERS_LINE_MAX}`,
      );
  });

  const lines = policyLines(headers);
  if (lines.length !== 1 || lines[0]?.rule !== "/*") {
    r.failures.push(
      `_headers has ${lines.length} Content-Security-Policy lines; it has one, in the rule for /*`,
    );
    return requireCounts(r, ["pages", "inline_scripts"]);
  }
  const policy = directives(lines[0].value);

  for (const [name, value] of FIXED) {
    const got = policy.get(name);
    if (got === undefined) r.failures.push(`the policy lacks ${name} ${value}`);
    else if (got.join(" ") !== value)
      r.failures.push(`the policy has ${name} ${got.join(" ")}, not ${name} ${value}`);
  }

  const script = policy.get("script-src") ?? [];
  if (script[0] !== "'self'" || script[1] !== "'wasm-unsafe-eval'")
    r.failures.push("script-src does not start with 'self' 'wasm-unsafe-eval'");
  const hashes = new Set<string>();
  for (const source of script.slice(2)) {
    const m = /^'(sha256-[A-Za-z0-9+/]+={0,2})'$/.exec(source);
    if (m?.[1] === undefined)
      r.failures.push(
        `script-src holds ${source}; it allows only 'self', 'wasm-unsafe-eval', and hashes`,
      );
    else hashes.add(m[1]);
  }
  r.counts.hashes = hashes.size;
  for (const [hash, page] of built)
    if (!hashes.has(hash)) r.failures.push(`${page} has an inline script with no hash: ${hash}`);
  for (const hash of hashes)
    if (!built.has(hash))
      r.failures.push(`script-src holds ${hash}, which names no inline script of the build`);

  // Plan 11b deviation 7: style-src is 'self' on a build with no inline style.
  // Otherwise it is 'self' 'unsafe-inline' with the measured counts in a comment.
  const style = (policy.get("style-src") ?? []).join(" ");
  const inlineStyle = styleElements + styleAttributes > 0;
  if (style === "'self'") {
    if (inlineStyle)
      r.failures.push(
        `style-src is 'self', but the build has ${styleElements} style elements and ${styleAttributes} style attributes`,
      );
  } else if (style === "'self' 'unsafe-inline'") {
    if (!inlineStyle)
      r.failures.push(
        "style-src holds 'unsafe-inline', but the build has no style element and no style attribute",
      );
    else if (!STYLE_COMMENT.test(headers))
      r.failures.push(
        "style-src holds 'unsafe-inline' and _headers lacks the line # style-src: <n> style elements and <m> style attributes in the build of <date>.",
      );
  } else
    r.failures.push(`style-src is ${style || "missing"}; it is 'self' or 'self' 'unsafe-inline'`);

  return requireCounts(r, ["pages", "inline_scripts"]);
}
