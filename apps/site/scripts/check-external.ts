import { SITE } from "../src/data/site.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * Each element and attribute by which a page loads a file, with the label
 * that a failure prints. A link to another origin is not here: a reader
 * follows it, and the page loads nothing by it.
 */
const LOADS: readonly { tag: string; attr: string; label: string; rel?: string }[] = [
  { tag: "script", attr: "src", label: "script src" },
  { tag: "link", attr: "href", label: "link stylesheet", rel: "stylesheet" },
  { tag: "link", attr: "href", label: "link preload", rel: "preload" },
  { tag: "link", attr: "href", label: "link modulepreload", rel: "modulepreload" },
  // Ruling 13 of the plan 11b lane: each other link that makes the browser fetch or connect.
  { tag: "link", attr: "href", label: "link icon", rel: "icon" },
  { tag: "link", attr: "href", label: "link apple-touch-icon", rel: "apple-touch-icon" },
  { tag: "link", attr: "href", label: "link manifest", rel: "manifest" },
  { tag: "link", attr: "href", label: "link preconnect", rel: "preconnect" },
  { tag: "link", attr: "href", label: "link prefetch", rel: "prefetch" },
  { tag: "img", attr: "src", label: "img src" },
  { tag: "img", attr: "srcset", label: "img srcset" },
  { tag: "source", attr: "src", label: "source src" },
  { tag: "source", attr: "srcset", label: "source srcset" },
  { tag: "iframe", attr: "src", label: "iframe src" },
  { tag: "video", attr: "src", label: "video src" },
  { tag: "audio", attr: "src", label: "audio src" },
  { tag: "video", attr: "poster", label: "video poster" },
  { tag: "object", attr: "data", label: "object data" },
  { tag: "embed", attr: "src", label: "embed src" },
];

/** The value of one attribute of a start tag, or null. */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m === null ? null : (m[1] ?? m[2] ?? m[3] ?? "");
}

/** Each URL of a srcset value: the first word of each comma-separated candidate. */
function srcsetUrls(value: string): string[] {
  return value
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0] ?? "")
    .filter((u) => u !== "");
}

/** True for an absolute URL (https?: or //) whose origin is not the site's. */
export function isExternal(url: string): boolean {
  const u = url.trim();
  if (!/^(https?:)?\/\//i.test(u)) return false;
  try {
    return new URL(u.startsWith("//") ? `https:${u}` : u).origin !== SITE.origin;
  } catch {
    return true;
  }
}

/** Each url() and @import target of a CSS text, with its label: `style` in a page, `css` in a file. */
function cssUrls(css: string, kind: "style" | "css" = "style"): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi))
    out.push({ url: m[1] ?? m[2] ?? m[3] ?? "", label: `${kind} @import` });
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    // An @import url(...) target is counted once, as the @import above.
    const before = css.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/@import\s+$/i.test(before)) continue;
    out.push({ url: m[1] ?? m[2] ?? m[3] ?? "", label: `${kind} url` });
  }
  return out;
}

/**
 * No page loads a file of another origin (plan 11b Global Constraints): no
 * web font, CDN, image, frame, or media. The site sets no cookie, so a
 * Set-Cookie line in dist/_headers fails. An `<a href>` to another origin
 * passes, and the count external_links shows each one. `styles` is each
 * .css file of dist by its path.
 */
export function checkExternal(
  pages: ReadonlyMap<string, string>,
  headers: string | null,
  styles: ReadonlyMap<string, string>,
): CheckReport {
  const r: CheckReport = {
    name: "check-external",
    counts: { pages: pages.size, styles: styles.size, external_links: 0 },
    failures: [],
  };
  if (headers === null) r.failures.push("dist/_headers is missing");
  else
    for (const line of headers.split("\n"))
      if (/^\s*Set-Cookie\s*:/i.test(line))
        r.failures.push(`_headers sets a cookie: ${line.trim()}`);

  for (const [page, html] of pages) {
    const fail = (url: string, label: string) => r.failures.push(`${page} loads ${url} (${label})`);
    for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*>/gi)) {
      const tag = m[0];
      const name = (m[1] ?? "").toLowerCase();
      if (name === "a") {
        const href = attrOf(tag, "href");
        if (href !== null && isExternal(href))
          r.counts.external_links = (r.counts.external_links ?? 0) + 1;
      }
      for (const load of LOADS) {
        if (load.tag !== name) continue;
        if (load.rel !== undefined) {
          const rel = (attrOf(tag, "rel") ?? "").toLowerCase().split(/\s+/);
          if (!rel.includes(load.rel)) continue;
        }
        const value = attrOf(tag, load.attr);
        if (value === null) continue;
        const urls = load.attr === "srcset" ? srcsetUrls(value) : [value];
        for (const url of urls) if (isExternal(url)) fail(url, load.label);
      }
      const style = attrOf(tag, "style");
      if (style !== null)
        for (const c of cssUrls(style.replace(/&quot;/g, '"').replace(/&#39;/g, "'")))
          if (isExternal(c.url)) fail(c.url, c.label);
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
      for (const c of cssUrls(m[1] ?? "")) if (isExternal(c.url)) fail(c.url, c.label);
  }
  // Each built style sheet: a url() or an @import in it loads a file as a page does.
  for (const [file, css] of styles)
    for (const c of cssUrls(css, "css"))
      if (isExternal(c.url)) r.failures.push(`${file} loads ${c.url} (${c.label})`);
  return requireCounts(r, ["pages", "styles"]);
}
