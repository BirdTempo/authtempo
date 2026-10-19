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

/** The directives of the policy, and no other (ruling 13 of the plan 11b lane). */
export const DIRECTIVES: readonly string[] = [
  ...FIXED.map(([name]) => name),
  "script-src",
  "style-src",
];

/**
 * The other headers of the rule for /*, each with its one value (spec 24
 * item 5 and the plan 11b brief). The rule sets these and the CSP, no more.
 */
const OTHER_HEADERS: readonly [name: string, value: string][] = [
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
];

/**
 * The count comment that `'unsafe-inline'` in style-src needs (plan 11b
 * deviation 7). write-headers.ts writes the counts of the build, and this
 * check counts the build again.
 */
const STYLE_COMMENT =
  /^# style-src counts in this build: style elements (\d+), style attributes (\d+)\./m;

/** The count of `<style>` elements and of `style` attributes of a page. */
export function styleCounts(html: string): { elements: number; attributes: number } {
  return {
    elements: [...html.matchAll(/<style\b/gi)].length,
    attributes: [...html.matchAll(/\sstyle\s*=/gi)].length,
  };
}

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

/** One header line of a _headers file, with the URL rule above it. */
interface HeaderLine {
  rule: string;
  name: string;
  value: string;
}

/** The URL rules of a _headers file in order, and each header line under them. */
function parseHeaders(text: string): { rules: string[]; lines: HeaderLine[] } {
  const rules: string[] = [];
  const lines: HeaderLine[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push(line.trim());
      continue;
    }
    const m = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (m) lines.push({ rule: rules.at(-1) ?? "", name: m[1] ?? "", value: (m[2] ?? "").trim() });
  }
  return { rules, lines };
}

/**
 * The directives of a policy by name, each with its sources, and each name
 * that occurs again. A browser keeps the first copy of a directive (CSP 3,
 * and Chrome 155 by the review probe of 2026-10-19), so this does too.
 */
function directives(policy: string): { map: Map<string, string[]>; repeated: string[] } {
  const map = new Map<string, string[]>();
  const repeated: string[] = [];
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (map.has(key)) repeated.push(key);
    else map.set(key, sources);
  }
  return { map, repeated };
}

/**
 * The CSP of dist/_headers against the build (plan 11b Task 3). The rule for
 * /* holds the one policy and the three other headers. Its script-src is
 * 'self', 'wasm-unsafe-eval', and one hash for each distinct inline script of
 * the build, and no other hash. write-headers.ts writes the hashes and the
 * style counts; this check reads the build again. `files` is each file of
 * dist, so a template that the writer did not delete fails.
 */
export function checkCsp(
  pages: ReadonlyMap<string, string>,
  headers: string | null,
  files: ReadonlySet<string>,
): CheckReport {
  const r: CheckReport = {
    name: "check-csp",
    counts: { pages: pages.size, inline_scripts: 0, hashes: 0 },
    failures: [],
  };
  if (headers === null) {
    r.failures.push("dist/_headers is missing");
    return r;
  }
  if (files.has("_headers.template"))
    r.failures.push("dist/_headers.template exists; write-headers.ts deletes it after the write");

  const built = new Map<string, string>();
  let styleElements = 0;
  let styleAttributes = 0;
  for (const [page, html] of pages) {
    for (const text of inlineScripts(html)) {
      const hash = scriptHash(text);
      if (!built.has(hash)) built.set(hash, page);
    }
    const styles = styleCounts(html);
    styleElements += styles.elements;
    styleAttributes += styles.attributes;
  }
  r.counts.inline_scripts = built.size;

  headers.split("\n").forEach((line, i) => {
    if (line.length > HEADERS_LINE_MAX)
      r.failures.push(
        `_headers line ${i + 1} has ${line.length} characters; the platform limit is ${HEADERS_LINE_MAX}`,
      );
  });

  const parsed = parseHeaders(headers);
  const all = parsed.rules.filter((rule) => rule === "/*").length;
  if (all !== 1) r.failures.push(`_headers has ${all} rules for /*; it has one`);
  // A report-only policy enforces nothing, and its report goes to a URL.
  for (const h of parsed.lines)
    if (h.name.toLowerCase() === "content-security-policy-report-only")
      r.failures.push(`the rule for ${h.rule} sets ${h.name}; the site sets no report-only policy`);
  const policies = parsed.lines.filter((h) => h.name.toLowerCase() === "content-security-policy");
  const policyLine = policies[0];
  if (policies.length !== 1 || policyLine === undefined || policyLine.rule !== "/*") {
    r.failures.push(
      `_headers has ${policies.length} Content-Security-Policy lines (${policies.map((h) => h.rule).join(", ")}); it has one, in the rule for /*`,
    );
    return requireCounts(r, ["pages", "inline_scripts"]);
  }

  // The rule for /* sets the policy and the three other headers, each once, and no other header.
  for (const [name, value] of OTHER_HEADERS) {
    const got = parsed.lines.filter(
      (h) => h.rule === "/*" && h.name.toLowerCase() === name.toLowerCase(),
    );
    if (got.length === 0) r.failures.push(`the rule for /* lacks ${name}: ${value}`);
    else if (got.length > 1) r.failures.push(`the rule for /* sets ${name} ${got.length} times`);
    else if (got[0]?.value !== value)
      r.failures.push(`the rule for /* has ${name}: ${got[0]?.value}, not ${name}: ${value}`);
  }
  const known = ["content-security-policy", ...OTHER_HEADERS.map(([n]) => n.toLowerCase())];
  for (const h of parsed.lines)
    if (h.rule === "/*" && !known.includes(h.name.toLowerCase()))
      r.failures.push(`the rule for /* sets ${h.name}, which is not a header of the site rule`);

  const { map: policy, repeated } = directives(policyLine.value);
  for (const name of repeated)
    r.failures.push(`the policy has ${name} more than once; a browser keeps the first copy`);
  for (const name of policy.keys())
    if (!DIRECTIVES.includes(name))
      r.failures.push(`the policy has ${name}; it has only ${DIRECTIVES.join(", ")}`);

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
  // Otherwise it is 'self' 'unsafe-inline', with the counts of the build in a comment.
  const style = (policy.get("style-src") ?? []).join(" ");
  const counts = `style elements ${styleElements}, style attributes ${styleAttributes}`;
  if (style === "'self'") {
    if (styleElements + styleAttributes > 0)
      r.failures.push(`style-src is 'self', but the build has ${counts}`);
  } else if (style === "'self' 'unsafe-inline'") {
    const comment = STYLE_COMMENT.exec(headers);
    if (styleElements + styleAttributes === 0)
      r.failures.push(
        "style-src holds 'unsafe-inline', but the build has no style element and no style attribute",
      );
    else if (comment === null)
      r.failures.push(
        "style-src holds 'unsafe-inline' and _headers lacks the line # style-src counts in this build: style elements <n>, style attributes <m>.",
      );
    else if (comment[1] !== String(styleElements) || comment[2] !== String(styleAttributes))
      r.failures.push(
        `the style-src comment states style elements ${comment[1]}, style attributes ${comment[2]}; the build has ${counts}`,
      );
  } else
    r.failures.push(`style-src is ${style || "missing"}; it is 'self' or 'self' 'unsafe-inline'`);

  return requireCounts(r, ["pages", "inline_scripts"]);
}
