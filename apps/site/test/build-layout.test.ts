import { existsSync, readFileSync } from "node:fs";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { walk } from "../scripts/lib/files.ts";
import { pageCss } from "../scripts/lib/html.ts";
import { DIST, SITE } from "../scripts/lib/paths.ts";
import { parseTokens } from "../scripts/lib/tokens.ts";
import { FEATURES, featureOrder } from "../src/data/features.ts";
import { HOME } from "../src/data/home.ts";
import { SIDEBAR_ICONS } from "../src/data/sidebar-icons.ts";

// `pnpm test` runs `astro build` before vitest, so dist is newer than the change.
const html = walk(DIST, (p) => p.endsWith(".html")).map((p) => p.slice(DIST.length));
const docsPages = html.filter((p) => p.startsWith("docs/"));

const tokenCss = readFileSync(`${SITE}src/styles/tokens.css`, "utf8");
const tokens = parseTokens(tokenCss);
const toggle = readFileSync(`${SITE}src/scripts/theme-toggle.js`, "utf8");
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

  it("links the lockup of the header home, with the beat", () => {
    const lockup = tags(page("index.html"), "a").find((t) => t.includes(' class="at-lockup'));
    expect(lockup).toMatch(/ class="at-lockup at-beat[ "]/);
    expect(lockup).toContain(' href="/"');
  });

  it("writes the title, the description, and the Open Graph values of the home page", () => {
    const home = page("index.html");
    expect(home).toContain(`<title>${HOME.title}</title>`);
    for (const [tag, attrs] of [
      ["meta", { name: "description", content: HOME.description }],
      ["link", { rel: "canonical", href: "https://authtempo.com/" }],
      ["meta", { property: "og:title", content: HOME.title }],
      ["meta", { property: "og:description", content: HOME.description }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:url", content: "https://authtempo.com/" }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ] as const)
      expect({ tag, attrs, found: hasTag(home, tag, attrs) }).toEqual({ tag, attrs, found: true });
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
      const defined = css.includes(`--at-paper:${tokens.light.get("--at-paper")}`);
      expect({ path, defined }).toEqual({ path, defined: true });
    }
  });

  it("puts the toggle script in the head and a labelled button in the header", () => {
    const home = page("index.html");
    expect(home.slice(0, home.indexOf("</head>"))).toContain(`<script>${toggle}</script>`);
    const button = tags(home, "button").find((t) => t.includes(" data-theme-toggle"));
    expect(button).toContain(' type="button"');
    expect(button).toContain(' aria-label="Use the light theme"');
    for (const name of ["half-disc", "sun", "moon"]) expect(home).toContain(`/icons.svg#${name}`);
  });

  it("hides the toggle until the script runs", () => {
    expect(pageCss(page("index.html"), read).replace(/\s+/g, "")).toContain(
      ":root:not([data-theme-choice])",
    );
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

// Starlight 0.42.6 sets scopedStyleStrategy "where", so Astro adds an astro-<hash>
// class to each element of a styled component. A class match allows that class.
describe("the home page (brand spec 9)", () => {
  it("shows the hero of the margin rail", () => {
    const home = page("index.html");
    // The head description holds the headline and the lede, so the texts are read in the hero only.
    const hero = home.split('<section class="hero')[1]?.split("</section>")[0] ?? "";
    for (const text of [
      HOME.headline,
      HOME.lede,
      ...HOME.claims,
      HOME.cta,
      "npm install @authtempo/core",
    ])
      expect({ text, found: hero.includes(text) }).toEqual({ text, found: true });
    const rail = /<div class="rail[ "][^>]*>([\s\S]*?)<\/div>/.exec(home)?.[1] ?? "";
    expect(rail.match(/<span\b/g)?.length).toBe(5);
    expect(rail.match(/rail-accent/g)?.length).toBe(1);
    expect(home).toMatch(/ class="hero-mark at-beat[ "]/);
    // The beat rules select .at-beat .at-mark rect, so the svg of the mark must keep its class.
    const mark = home.split(/ class="hero-mark at-beat[ "]/)[1]?.split("</span>")[0] ?? "";
    expect(tags(mark, "svg").some((t) => / class="(?:[^"]* )?at-mark[ "]/.test(t))).toBe(true);
  });

  it("lists one feature row per RouteFeature member, in route order", () => {
    const home = page("index.html");
    const ids = [...home.matchAll(/ id="feature-([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(featureOrder(ROUTES));
    for (const f of featureOrder(ROUTES)) {
      const row = home.split(`id="feature-${f}"`)[1]?.split("</li>")[0] ?? "";
      for (const part of [`/icons.svg#${FEATURES[f].icon}`, FEATURES[f].title, FEATURES[f].line])
        expect({ f, part, found: row.includes(part) }).toEqual({ f, part, found: true });
    }
    expect(home.match(/ class="at-icon (?:astro-\w+ )?at-draw"/g)?.length).toBe(
      featureOrder(ROUTES).length,
    );
  });

  it("delays the draw of each feature row after the first by 0.1 s more", () => {
    const rules = [
      ...tokenCss.matchAll(
        /\.at-draw-list > :nth-child\((\d+)\) \.at-draw \{\s*animation-delay: ([\d.]+)s;\s*\}/g,
      ),
    ].map((m) => [Number(m[1]), Number(m[2])]);
    const rows = featureOrder(ROUTES).length;
    expect(rules).toEqual(
      Array.from({ length: rows - 1 }, (_, i) => [i + 2, Number(((i + 1) / 10).toFixed(1))]),
    );
  });

  it("shows the route count and the vendor count from code", () => {
    const numbers = [...page("index.html").matchAll(/<dd\b[^>]*>(\d+)<\/dd>/g)].map((m) =>
      Number(m[1]),
    );
    // The vendor count is typed here. home-data.test.ts holds the scan of core to the same list.
    const vendors: readonly string[] = [];
    expect(numbers).toEqual([ROUTES.length, vendors.length]);
  });

  it("shows the one-call code block of the tested sample", () => {
    const home = page("index.html");
    expect(home).toMatch(/<pre class="code at-card at-lift[ "]/);
    for (const line of ["createAuth({", "trustedOrigins: [", "storage: deps.storage,"])
      expect({ line, found: home.includes(line) }).toEqual({ line, found: true });
  });
});

describe("the docs theme (brand spec 11)", () => {
  const docs = page("docs/index.html");
  const css = (path: string) => pageCss(page(path), read).replace(/\s+/g, "");
  const RAIL = "insetvar\\(--at-rail\\)00var\\(--at-accent\\)";

  it("gives each top-level sidebar group its icon before its label", () => {
    const sidebar =
      docs.split("<sl-sidebar-state-persist")[1]?.split("</sl-sidebar-state-persist>")[0] ?? "";
    for (const [label, icon] of Object.entries(SIDEBAR_ICONS)) {
      const at = sidebar.indexOf(`>${label}</span>`);
      // The icon sits in the group's summary, before the group-label span (SidebarSublist.astro).
      const before = sidebar.slice(Math.max(0, sidebar.lastIndexOf("<summary", at)), at);
      expect({ label, found: at > 0, icon: before.includes(`/icons.svg#${icon}`) }).toEqual({
        label,
        found: true,
        icon: true,
      });
    }
    expect(sidebar.match(/ class="at-icon group-icon(?: astro-\w+)?"/g)?.length).toBe(
      Object.keys(SIDEBAR_ICONS).length,
    );
  });

  it("puts the lockup in the docs header", () => {
    const header = docs.split(/<header class="header[ "]/)[1]?.split("</header>")[0] ?? "";
    expect(header).toMatch(/ class="at-lockup[ "]/);
    expect(header).toContain('aria-label="authtempo"');
    // Starlight's title carries translate="no", so a page translator leaves the name.
    const lockup = tags(header, "a").find((t) => / class="at-lockup[ "]/.test(t)) ?? "";
    expect(lockup).toContain(' translate="no"');
  });

  it("restyles Starlight's theme select with the three sprite icons", () => {
    expect(docs).toContain("<starlight-theme-select");
    const select =
      docs.split(/ class="at-theme-select[ "]/)[1]?.split("</starlight-theme-select>")[0] ?? "";
    expect(select).toContain("<starlight-theme-select");
    for (const name of ["half-disc", "sun", "moon"])
      expect({ name, found: select.includes(`/icons.svg#${name}`) }).toEqual({ name, found: true });
  });

  it("shows the icon of the checked option and hides the select over it", () => {
    const docsCss = css("docs/index.html");
    for (const choice of ["auto", "light", "dark"])
      expect({
        choice,
        shown: new RegExp(
          `\\.at-theme-select[^{},]*:has\\(option\\[value=("?)${choice}\\1\\]:checked\\)\\.at-choice-${choice}(?:,[^{]*)?\\{display:block[;}]`,
        ).test(docsCss),
      }).toEqual({ choice, shown: true });
    expect(docsCss).toMatch(/\.at-theme-select[^{},]*select\{[^}]*opacity:0[;}]/);
    expect(docsCss).toMatch(/\.at-theme-select[^{},]*select\{[^}]*padding:0[;}]/);
    expect(docsCss).toMatch(/\.at-theme-select[^{},]*select\{[^}]*margin:0[;}]/);
  });

  it("rings the theme select when its select has focus", () => {
    expect(css("docs/index.html")).toMatch(
      /\.at-theme-select[^{]*:has\(select:focus-visible\)\{outline:var\(--at-ring\);outline-offset:var\(--at-ring-offset\)[;}]/,
    );
  });

  it("marks the one link of the current page in the sidebar", () => {
    const sidebar = (path: string) =>
      page(path).split("<sl-sidebar-state-persist")[1]?.split("</sl-sidebar-state-persist>")[0] ??
      "";
    for (const [path, href] of [
      ["docs/start/first-sign-in/index.html", "/docs/start/first-sign-in/"],
      ["docs/faq/index.html", "/docs/faq/"],
    ] as const) {
      const current = tags(sidebar(path), "a").filter((t) => t.includes(' aria-current="page"'));
      expect({
        path,
        count: current.length,
        href: current[0]?.includes(` href="${href}"`),
      }).toEqual({
        path,
        count: 1,
        href: true,
      });
    }
  });

  it("draws no rule under each element with the class header", () => {
    // Starlight's header.header has the hairline. A bare .header rule also
    // matches the inner header div and each code frame caption.
    expect(css("docs/start/first-sign-in/index.html")).not.toMatch(
      /(^|[{},])\.header(,[^{]*)?\{[^}]*border-bottom/,
    );
  });

  it("marks the active page and the active heading with the rail", () => {
    const docsCss = css("docs/index.html");
    expect(docsCss).toMatch(
      new RegExp(`\\[aria-current=("?)page\\1\\][^{]*\\{[^}]*box-shadow:${RAIL}`),
    );
    expect(docsCss).toMatch(
      new RegExp(`starlight-toca\\[aria-current=("?)true\\1\\][^{]*\\{[^}]*box-shadow:${RAIL}`),
    );
  });

  it("puts every code frame on the code token, with no border and no shadow", () => {
    const codeCss = css("docs/start/first-sign-in/index.html");
    expect(codeCss).toContain(".expressive-code");
    const value = (name: string) =>
      [...codeCss.matchAll(new RegExp(`${name}:([^;}]*)`, "g"))].map((m) => m[1]);
    for (const [name, want] of [
      ["--ec-codeBg", "var(--at-code)"],
      ["--ec-codeFg", "var(--at-code-ink)"],
      ["--ec-frm-edBg", "var(--at-code)"],
      ["--ec-frm-trmBg", "var(--at-code)"],
      ["--ec-frm-trmTtbBg", "var(--at-code)"],
      ["--ec-frm-edTabBarBg", "var(--at-code)"],
      ["--ec-frm-edActTabBg", "var(--at-code)"],
      ["--ec-frm-trmTtbBrdBtmCol", "var(--at-line)"],
      ["--ec-frm-edTabBarBrdBtmCol", "var(--at-line)"],
      ["--ec-brdWd", "0px"],
      ["--ec-frm-frameBoxShdCssVal", "none"],
      ["--ec-sbThumbCol", "var(--at-mute)"],
      ["--ec-sbThumbHoverCol", "var(--at-code-ink)"],
      ["--ec-focusBrd", "var(--at-accent)"],
      ["--ec-codeSelBg", "var(--at-accent)"],
      ["--ec-uiSelBg", "var(--at-code-ink)"],
      ["--ec-uiSelFg", "var(--at-code)"],
      ["--ec-frm-edActTabFg", "var(--at-code-ink)"],
      ["--ec-frm-trmTtbFg", "var(--at-code-ink)"],
      ["--ec-frm-trmTtbDotsFg", "var(--at-code-ink)"],
      ["--ec-frm-tooltipSuccessBg", "var(--at-code-ink)"],
      ["--ec-frm-tooltipSuccessFg", "var(--at-code)"],
    ] as const)
      expect({ name, values: value(name) }).toEqual({ name, values: [want] });
    // No rule reads the selection colors. A rule that does needs a contrast check first.
    for (const name of ["--ec-codeSelBg", "--ec-uiSelBg", "--ec-uiSelFg"])
      expect({ name, read: codeCss.includes(`var(${name})`) }).toEqual({ name, read: false });
  });
});
