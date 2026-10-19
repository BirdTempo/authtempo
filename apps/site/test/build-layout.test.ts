import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { walk } from "../scripts/lib/files.ts";
import { pageCss } from "../scripts/lib/html.ts";
import { DIST, SITE } from "../scripts/lib/paths.ts";
import { parseTokens } from "../scripts/lib/tokens.ts";
import { HOME } from "../src/data/home.ts";

// `pnpm test` runs `astro build` before vitest, so dist is newer than the change.
const html = walk(DIST, (p) => p.endsWith(".html")).map((p) => p.slice(DIST.length));
const docsPages = html.filter((p) => p.startsWith("docs/"));

const tokens = parseTokens(readFileSync(`${SITE}src/styles/tokens.css`, "utf8"));
const page = (path: string) => readFileSync(`${DIST}${path}`, "utf8");
const read = (href: string) => {
  const file = `${DIST}${href.slice(1)}`;
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
/** Each tag of a kind, as its source text. */
const tags = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map((m) => m[0]);
/** True when one tag of the kind has each attribute with its value, in any order. */
const hasTag = (html: string, tag: string, attrs: Record<string, string>) =>
  tags(html, tag).some((t) => Object.entries(attrs).every(([k, v]) => t.includes(` ${k}="${v}"`)));

describe("the build layout (plan 11a)", () => {
  it("puts every docs page under /docs/ and the 404 page at the root", () => {
    expect(docsPages).toContain("docs/index.html");
    expect(html.filter((p) => !p.startsWith("docs/")).sort()).toEqual(["404.html", "index.html"]);
    expect(html.some((p) => p.startsWith("docs/docs/"))).toBe(false);
  });

  it("the search index holds docs pages and no landing page", () => {
    expect(readFileSync(`${DIST}index.html`, "utf8")).not.toContain("data-pagefind-body");
    for (const page of docsPages)
      expect({
        page,
        marked: readFileSync(`${DIST}${page}`, "utf8").includes("data-pagefind-body"),
      }).toEqual({ page, marked: true });
    expect(existsSync(`${DIST}pagefind/pagefind.js`)).toBe(true);
    const entry = JSON.parse(readFileSync(`${DIST}pagefind/pagefind-entry.json`, "utf8")) as {
      languages: Record<string, { page_count: number }>;
    };
    const indexed = Object.values(entry.languages).reduce((n, l) => n + l.page_count, 0);
    expect(indexed).toBe(docsPages.length);
  });
});

describe("the root layout (plan 11b1)", () => {
  it("serves the home page on the site layout", () => {
    const home = page("index.html");
    for (const part of [
      '<html lang="en"',
      '<meta name="viewport" content="width=device-width, initial-scale=1"',
      'class="site-header',
      'class="at-lockup',
      'aria-label="authtempo"',
      '<main id="main"',
      'class="site-footer',
      'href="#main"',
      'href="/docs/"',
    ])
      expect({ part, found: home.includes(part) }).toEqual({ part, found: true });
  });

  it("sets the metadata of brand spec 13 on every page but the 404 page", () => {
    for (const path of html.filter((p) => p !== "404.html")) {
      const h = page(path);
      const description = tags(h, "meta")
        .find((t) => t.includes(' name="description"'))
        ?.match(/ content="([^"]*)"/)?.[1];
      expect({
        path,
        ok: description !== undefined && description.length > 0 && description.length < 160,
      }).toEqual({ path, ok: true });
      for (const [tag, attrs] of [
        ["meta", { property: "og:image", content: "https://authtempo.com/og.png" }],
        [
          "meta",
          {
            name: "theme-color",
            media: "(prefers-color-scheme: light)",
            content: tokens.light.get("--at-paper") ?? "",
          },
        ],
        [
          "meta",
          {
            name: "theme-color",
            media: "(prefers-color-scheme: dark)",
            content: tokens.darkAttr.get("--at-paper") ?? "",
          },
        ],
        ["link", { rel: "manifest", href: "/site.webmanifest" }],
        ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
        // Starlight writes rel="shortcut icon" (utils/head.js of 0.42.6), so only the href is held.
        ["link", { href: "/favicon.svg" }],
      ] as const)
        expect({ path, tag, attrs, found: hasTag(h, tag, attrs) }).toEqual({
          path,
          tag,
          attrs,
          found: true,
        });
    }
  });

  it("shares one token file with the docs", () => {
    // A reference such as var(--at-paper) is not enough: the definition must reach each page.
    for (const path of ["index.html", "docs/index.html"]) {
      const css = pageCss(page(path), read).replace(/\s+/g, "");
      expect({ path, defined: css.includes("--at-paper:#f6f5f2") }).toEqual({
        path,
        defined: true,
      });
    }
  });

  it("states the license and the version of core in the footer", () => {
    const root = JSON.parse(readFileSync(`${SITE}../../package.json`, "utf8")) as {
      license?: string;
    };
    const core = JSON.parse(readFileSync(`${SITE}../../packages/core/package.json`, "utf8")) as {
      version: string;
    };
    const footer = page("index.html").split('class="site-footer')[1] ?? "";
    expect(footer).toContain(`authtempo · ${root.license ?? HOME.noLicense}`);
    expect(footer).toContain(core.version);
  });
});
