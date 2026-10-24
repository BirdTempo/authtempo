import { existsSync, readFileSync } from "node:fs";
import { STACK_INFO, STACKS } from "@authtempo/cli/stacks";
import { ipKey } from "@authtempo/core";
import { ROUTES } from "@authtempo/core/routes";
import {
  DEMO_EXEMPT,
  DEMO_FEATURES,
  DEMO_LIMITS,
  DEMO_PUBLISHED,
  DOCS_BASE,
} from "@authtempo/demo/facts";
import { describe, expect, it } from "vitest";
import { walk } from "../scripts/lib/files.ts";
import { pageCss } from "../scripts/lib/html.ts";
import { DIST, SITE } from "../scripts/lib/paths.ts";
import { parseTokens } from "../scripts/lib/tokens.ts";
import { COMPARE_ROWS } from "../src/data/compare.ts";
import { PLATFORM_COSTS } from "../src/data/costs.ts";
import { demoEnd, ipv6Prefix } from "../src/data/demo.ts";
import { FEATURES, featureOrder, PACKAGE_FEATURES } from "../src/data/features.ts";
import { HOME } from "../src/data/home.ts";
import { readRepoText } from "../src/data/repo.ts";
import { renderPolicy } from "../src/data/security.ts";
import { SIDEBAR_ICONS } from "../src/data/sidebar-icons.ts";
import { SITE as SITE_NAMES } from "../src/data/site.ts";

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
/** The text of an HTML fragment: no tags, the spaces joined. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
/** The part of main of a root page. */
const mainOf = (path: string) => page(path).split('<main id="main"')[1]?.split("</main>")[0] ?? "";
/**
 * The hero of brand spec 10 (ruling 17 of the plan 11b lane). The first element
 * of main holds the rail, the h1, and a lede of one sentence.
 */
function expectHero(path: string, title: string): void {
  const hero =
    /^[^>]*>\s*<div class="hero[ "][^>]*>([\s\S]*?)<\/p>\s*<\/div>\s*<\/div>/.exec(
      mainOf(path),
    )?.[1] ?? "";
  const rail = /<div class="rail[ "][^>]*>([\s\S]*?)<\/div>/.exec(hero)?.[1] ?? "";
  expect({ path, marks: rail.match(/<span\b/g)?.length }).toEqual({ path, marks: 5 });
  expect({ path, accent: rail.match(/rail-accent/g)?.length }).toEqual({ path, accent: 1 });
  expect({ path, h1: new RegExp(`<h1\\b[^>]*>${title}</h1>`).test(hero) }).toEqual({
    path,
    h1: true,
  });
  const lede = (hero.split(/<div class="lede[ "][^>]*>/)[1] ?? "").replace(/<[^>]+>/g, "").trim();
  const sentences = lede.split(/(?<=[.?!])\s+/).filter((t) => t.length > 0);
  expect({ path, sentences: sentences.length, words: lede.split(/\s+/).length <= 25 }).toEqual({
    path,
    sentences: 1,
    words: true,
  });
}
/** The plan names that a cost row can state. A new plan name joins this list. */
const PLANS = ["Workers Free", "Workers Paid"];
/**
 * The terms of a cost text (rulings 21 and 22). Each number pairs with the first
 * plan name after it, and the pairs compare as a set. Each plan name that no
 * number claims keeps its order, so a swap of two plans fails.
 */
function costTerms(text: string): { pairs: string[]; plans: string[] } {
  const tokens = [...text.matchAll(new RegExp(`\\b\\d+\\b|${PLANS.join("|")}`, "g"))].map(
    (m) => m[0],
  );
  const claimed = new Set<number>();
  const pairs = tokens.flatMap((t, i) => {
    if (!/^\d+$/.test(t)) return [];
    const at = tokens.findIndex((u, k) => k > i && PLANS.includes(u));
    if (at >= 0) claimed.add(at);
    return [`${t} ${at >= 0 ? tokens[at] : "-"}`];
  });
  const plans = tokens.filter((t, i) => PLANS.includes(t) && !claimed.has(i));
  return { pairs: pairs.sort(), plans };
}
/** True when one tag of the kind has each attribute with its value, in any order. */
const hasTag = (html: string, tag: string, attrs: Record<string, string>) =>
  tags(html, tag).some((t) => Object.entries(attrs).every(([k, v]) => t.includes(` ${k}="${v}"`)));

describe("the build layout (plan 11a)", () => {
  it("puts every docs page under /docs/ and the 404 page at the root", () => {
    expect(docsPages).toContain("docs/index.html");
    expect(html.filter((p) => !p.startsWith("docs/")).sort()).toEqual([
      "404.html",
      "compare/index.html",
      "demo/index.html",
      "features/index.html",
      "index.html",
      "pricing/index.html",
      "security/index.html",
    ]);
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

describe("the root layout (plan 11b)", () => {
  // Each link of the plan joins with its page, so check-links never meets a missing page.
  it("links the changelog in the footer", () => {
    const footer = page("index.html").split('class="site-footer')[1] ?? "";
    expect(footer).toMatch(/<a\b[^>]* href="\/docs\/changelog\/"[^>]*>Changelog<\/a>/);
  });

  it("links the features page in the footer", () => {
    const footer = page("index.html").split('class="site-footer')[1] ?? "";
    expect(footer).toMatch(/<a\b[^>]* href="\/features\/"[^>]*>Features<\/a>/);
  });

  it("links the pricing and security pages in the footer, after Features", () => {
    const footer = page("index.html").split('class="site-footer')[1] ?? "";
    const labels = [...footer.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels.slice(0, 3)).toEqual(["Features", "Pricing", "Security"]);
    expect(footer).toMatch(/<a\b[^>]* href="\/pricing\/"[^>]*>Pricing<\/a>/);
    expect(footer).toMatch(/<a\b[^>]* href="\/security\/"[^>]*>Security<\/a>/);
  });

  it("keeps the theme toggle at the right end of the top row below 48rem (brand spec 12)", () => {
    // Each @media block of the page CSS, cut at the next @media. The phone block puts the nav on a row of its own.
    const phone = pageCss(page("index.html"), read)
      .split("@media")
      .filter((b) => /^\s*\((?:max-width:\s*47\.99rem|width\s*<=\s*47\.99rem)\)/.test(b));
    const header = phone.find((b) => b.includes('grid-template-areas:"lockup toggle""nav nav"'));
    expect(header).toBeDefined();
    expect(header).toMatch(/\.at-toggle[^{]*\{grid-area:toggle\}/);
    expect(header).toMatch(/\.site-header[^{]* nav[^{]*\{grid-area:nav;margin-inline-start:0\}/);
  });

  // Plan 11b Task 7, ruling 7 of its lane: the feed is the last footer link, and each root page names it in its head.
  it("links the feed in the footer after Changelog, and in the head of each root page", () => {
    const footer = page("index.html").split('class="site-footer')[1] ?? "";
    const labels = [...footer.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels.slice(-2)).toEqual(["Changelog", "Feed"]);
    expect(footer).toMatch(/<a\b[^>]* href="\/feed\.xml"[^>]*>Feed<\/a>/);
    for (const path of ["index.html", "features/index.html", "compare/index.html"]) {
      const head = page(path).split("</head>")[0] ?? "";
      const alternates = tags(head, "link").filter((t) => t.includes('rel="alternate"'));
      expect({ path, alternates }).toEqual({
        path,
        alternates: [
          '<link rel="alternate" type="application/atom+xml" title="authtempo releases" href="/feed.xml">',
        ],
      });
    }
    expect(existsSync(`${DIST}feed.xml`)).toBe(true);
  });

  it("marks the link of the current page, and no other link, in the header and the footer", () => {
    // The path prop of Site.astro names the page; the lockup of the header is not a nav link.
    const current = (path: string) =>
      tags(page(path), "a")
        .filter((t) => t.includes(' aria-current="page"'))
        .map((t) => / href="([^"]*)"/.exec(t)?.[1]);
    expect(current("features/index.html")).toEqual(["/features/"]);
    expect(current("index.html")).toEqual([]);
  });
});

describe("the features page (plan 11b)", () => {
  // Brand spec 10 (ruling 17 of the plan 11b lane): the nav and the footer, then a hero with the rail and a one-line lede.
  it("opens with the hero of brand spec 10: the rail, the h1, and a lede of one sentence", () => {
    expectHero("features/index.html", "Features");
  });

  it("lists one section per feature in route order, then one per package folder", () => {
    const ids = [...page("features/index.html").matchAll(/<section\b[^>]* id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual([
      ...featureOrder(ROUTES),
      ...Object.keys(PACKAGE_FEATURES).map((folder) => `pkg-${folder}`),
    ]);
  });

  it("links each feature title to its guide", () => {
    const html = page("features/index.html");
    for (const f of featureOrder(ROUTES)) {
      const section = html.split(` id="${f}"`)[1]?.split("</section>")[0] ?? "";
      const linked = tags(section, "a").some((t) => t.includes(` href="${FEATURES[f].guide}"`));
      expect({ f, linked, line: section.includes(FEATURES[f].line) }).toEqual({
        f,
        linked: true,
        line: true,
      });
    }
  });
});

describe("the pricing and security pages (plan 11b)", () => {
  it.each([
    ["pricing/index.html", "Free and owned"],
    ["security/index.html", "Security"],
  ])("opens %s with the hero of brand spec 10", (path, title) => {
    expectHero(path, title);
  });

  it("states the license, or that it is not set", () => {
    const root = JSON.parse(readRepoText("package.json") ?? "{}") as { license?: unknown };
    const text = textOf(mainOf("pricing/index.html"));
    // A license is a string that is not blank; "" or a value of another type is not set.
    const set = typeof root.license === "string" && root.license.trim() !== "";
    const line = set ? `The license is ${String(root.license)}.` : "The license is not set yet.";
    expect({ line, found: text.includes(line) }).toEqual({ line, found: true });
    expect(text.includes("The license is")).toBe(true);
  });

  it("states the reporting channel, or that it is not set", async () => {
    const policy = readRepoText("SECURITY.md");
    const main = mainOf("security/index.html");
    // The section runs from the h2 "Report a fault" to the end of main.
    const section = main.split(/<h2\b[^>]*>Report a fault<\/h2>/)[1] ?? "";
    const empty = "The reporting channel is not set yet. It comes with the first release.";
    if (policy === null) expect(textOf(section)).toBe(empty);
    else {
      expect(section.includes(await renderPolicy(policy))).toBe(true);
      expect(section.includes(empty)).toBe(false);
    }
    expect(main.match(/<h1\b/g)?.length).toBe(1);
  });

  it("links each platform cost to a page of the build", () => {
    const table = mainOf("pricing/index.html").split("<table")[1]?.split("</table>")[0] ?? "";
    const rows = table.split("<tr").slice(2);
    expect(rows.length).toBe(PLATFORM_COSTS.length);
    PLATFORM_COSTS.forEach((cost, i) => {
      const href = `${cost.page}${cost.anchor === undefined ? "" : `#${cost.anchor}`}`;
      const row = rows[i] ?? "";
      const target = `${cost.page.slice(1)}index.html`;
      const built = existsSync(`${DIST}${target}`) ? page(target) : "";
      expect({
        fact: cost.fact,
        inRow: textOf(row).includes(cost.fact),
        linked: tags(row, "a").some((t) => t.includes(` href="${href}"`)),
        page: built !== "",
        anchor: cost.anchor === undefined || built.includes(` id="${cost.anchor}"`),
      }).toEqual({ fact: cost.fact, inRow: true, linked: true, page: true, anchor: true });
    });
  });

  it("holds each platform cost to a sentence of its docs section", () => {
    // Ruling 19 of the plan 11b lane: a row whose page does not state its fact fails.
    for (const cost of PLATFORM_COSTS) {
      const target = `${cost.page.slice(1)}index.html`;
      const body = existsSync(`${DIST}${target}`)
        ? (page(target).split("data-pagefind-body")[1] ?? "")
        : "";
      // The section runs from the heading with the anchor to the next h2.
      const section =
        cost.anchor === undefined
          ? body
          : (body.split(` id="${cost.anchor}"`)[1]?.split(/<h2\b/)[0] ?? "");
      expect({ fact: cost.fact, held: textOf(section).includes(cost.quote) }).toEqual({
        fact: cost.fact,
        held: true,
      });
    }
  });

  it("reads the terms of a cost text: each number with its plan, and the order of the other plans", () => {
    expect(costTerms("D1 goes back 7 days on Workers Free, and 30 days on Workers Paid.")).toEqual({
      pairs: ["30 Workers Paid", "7 Workers Free"],
      plans: [],
    });
    expect(costTerms("It needs Workers Paid: Workers Free gives 1 slot.")).toEqual({
      pairs: ["1 -"],
      plans: ["Workers Paid", "Workers Free"],
    });
  });

  it("holds each number and plan name of each shown fact to its quote, both ways", () => {
    for (const cost of PLATFORM_COSTS)
      expect({ fact: cost.fact, terms: costTerms(cost.fact) }).toEqual({
        fact: cost.fact,
        terms: costTerms(cost.quote),
      });
  });

  it("links the threat model, the limits, and the cookies under Read more, by their titles", () => {
    const main = mainOf("security/index.html");
    const section = main.split(/<h2\b[^>]*>Read more<\/h2>/)[1]?.split(/<h2\b/)[0] ?? "";
    const links = [...section.matchAll(/<a\b[^>]* href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(links).toEqual([
      ["/docs/concepts/threat-model/", "The threat model"],
      ["/docs/reference/limits/", "Limits"],
      ["/docs/reference/cookies/", "Cookies"],
    ]);
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

  it("lists each stack of STACKS on the home page with a page of the build", () => {
    const home = page("index.html");
    const ids = [...home.matchAll(/ id="stack-([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...STACKS]);
    for (const stack of STACKS) {
      const row = home.split(` id="stack-${stack}"`)[1]?.split("</li>")[0] ?? "";
      const href = `/docs/start/${STACK_INFO[stack].page}/`;
      const label = STACK_INFO[stack].label;
      const shown = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
      const code = /<code\b[^>]*>([\s\S]*?)<\/code>/.exec(row)?.[1] ?? "";
      expect({
        stack,
        linked: new RegExp(`<a\\b[^>]* href="${href}"[^>]*>${shown}</a>`).test(row),
        command: textOf(code) === `authtempo init my-app --stack ${stack}`,
        // Each word is a span that does not wrap, so the line breaks at spaces only.
        words: code.match(/<span class="word[ "]/g)?.length === 5,
        built: existsSync(`${DIST}${href.slice(1)}index.html`),
      }).toEqual({ stack, linked: true, command: true, words: true, built: true });
    }
    // The workers-postgres stack has the tutorial workers-hyperdrive (STACK_INFO).
    expect(home).toContain('href="/docs/start/workers-hyperdrive/"');
    // A label starts with a capital on the page (the review of Task 5, Low 4).
    expect(home).toMatch(/>An MCP server on Cloudflare Workers with D1<\/a>/);
  });

  it("lists each feature on the home page with its anchor", () => {
    const home = page("index.html");
    const features = page("features/index.html");
    for (const f of featureOrder(ROUTES)) {
      const row = home.split(`id="feature-${f}"`)[1]?.split("</li>")[0] ?? "";
      expect({
        f,
        linked: tags(row, "a").some((t) => t.includes(` href="/features/#${f}"`)),
        anchor: features.includes(`<section id="${f}"`),
      }).toEqual({ f, linked: true, anchor: true });
    }
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

describe("the compare page (plan 11b Task 6)", () => {
  // Brand spec 10 (ruling 17 of the plan 11b lane): the hero with the rail and a one-line lede.
  it("opens with the hero of brand spec 10", () => {
    expectHero("compare/index.html", "Compare");
  });

  it("links Compare in the header, right after Docs (ruling 7)", () => {
    const header = page("index.html").split('class="site-header')[1]?.split("</header>")[0] ?? "";
    const nav = header.split("<nav")[1]?.split("</nav>")[0] ?? "";
    const labels = [...nav.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels.slice(0, 2)).toEqual(["Docs", "Compare"]);
    expect(nav).toMatch(/<a\b[^>]* href="\/compare\/"[^>]*>Compare<\/a>/);
  });

  it("shows one table a side, in the order of the plan, then the hosted providers", () => {
    const main = mainOf("compare/index.html");
    const sections = main.split(/<h2\b[^>]*>/).slice(1);
    const headings = sections.map((s) => s.split("</h2>")[0]);
    expect(headings).toEqual([
      "Where authtempo does more",
      "Where both do the same",
      "Where Better Auth does more today",
      "The hosted providers",
    ]);
    const ids = (s: string) =>
      [...s.matchAll(/<tr\b[^>]* id="((?:cmp|host)-[^"]+)"/g)].map((m) => m[1]);
    const sides = ["authtempo", "parity", "better-auth"] as const;
    sides.forEach((side, i) => {
      const want = COMPARE_ROWS.filter((r) => r.side === side).map((r) => `cmp-${r.id}`);
      expect({ side, ids: ids(sections[i] ?? "") }).toEqual({ side, ids: want });
    });
    expect(ids(sections[3] ?? "")).toEqual([
      "host-supabase",
      "host-clerk",
      "host-auth0",
      "host-firebase",
      "host-cognito",
      "host-workos",
      "host-authjs",
    ]);
  });

  it("states the source rule and the age limit in the first paragraph after the hero", () => {
    const after = mainOf("compare/index.html").split('<div class="cmp prose">')[1] ?? "";
    const first = textOf(after.split("</p>")[0] ?? "");
    expect(first).toBe(
      "Each row names its source and the day we read it. A row older than 180 days fails our build, so this page cannot show an old fact.",
    );
  });

  it("shows no image and no logo of another product (brand spec 10)", () => {
    const main = mainOf("compare/index.html");
    expect(tags(main, "img")).toEqual([]);
    expect(tags(main, "svg")).toEqual([]);
    expect(tags(main, "picture")).toEqual([]);
  });
});

describe("the demo page (plan 11b Task 12)", () => {
  const main = () => mainOf("demo/index.html");
  /** The part of main from the h2 of `heading` to the next h2. */
  const section = (heading: string) =>
    main()
      .split(new RegExp(`<h2\\b[^>]*>${heading}</h2>`))[1]
      ?.split(/<h2\b/)[0] ?? "";

  it("opens /demo/ with the hero of brand spec 10", () => {
    expectHero("demo/index.html", "Demo");
  });

  it("links the demo page in the header right after Compare (ruling 7)", () => {
    const header =
      page("index.html").split('<header class="site-header')[1]?.split("</header>")[0] ?? "";
    const links = [...header.matchAll(/<nav\b[\s\S]*?<\/nav>/g)][0]?.[0] ?? "";
    const labels = [...links.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Docs", "Compare", "Demo"]);
    expect(links).toMatch(/<a\b[^>]* href="\/demo\/"[^>]*>Demo<\/a>/);
  });

  it("links the demo page from the section Try it of the home", () => {
    const home = page("index.html");
    const tryIt = home.split('<section class="try')[1]?.split("</section>")[0] ?? "";
    expect(tryIt).toMatch(/<h2\b[^>]*>Try it<\/h2>/);
    expect(tags(tryIt, "a")).toHaveLength(1);
    expect(tryIt).toMatch(/<a\b[^>]* href="\/demo\/"[^>]*>/);
  });

  it("lists each demo feature and each exemption from the demo facts", () => {
    const shows = section("What the demo shows");
    const items = [...shows.matchAll(/<li\b[^>]* id="shows-([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
    expect(items.map((m) => m[1])).toEqual([...DEMO_FEATURES]);
    for (const [, feature = "", body = ""] of items) {
      const f = feature as (typeof DEMO_FEATURES)[number];
      expect({ f, body: textOf(body) }).toEqual({ f, body: FEATURES[f].title });
      expect({ f, link: body.includes(`href="/features/#${f}"`) }).toEqual({ f, link: true });
    }
    // The twelve features of ruling 33, and health of plan 12h (every deployment
    // serves it), typed here, so a lost member fails this test too.
    expect(items).toHaveLength(13);

    const off = section("What the demo does not show");
    const rows = [
      ...off.matchAll(/<div\b([^>]*)><dt\b[^>]*>([^<]*)<\/dt><dd\b[^>]*>([^<]*)<\/dd><\/div>/g),
    ];
    const exempt = rows.filter((m) => / id="off-/.test(m[1] ?? ""));
    expect(exempt.map((m) => / id="off-([^"]+)"/.exec(m[1] ?? "")?.[1])).toEqual(
      Object.keys(DEMO_EXEMPT),
    );
    // The 19 exempt features, typed here, so a lost member fails this test too.
    // Plan 12e adds oauthDevice, plan 12f operatorUsers and operatorImpersonation,
    // plan 12k dynamicRoles and teams, plan 12h readiness, and plan 12d sso,
    // operatorSso, and scim, and plan 12i passkeyRelatedOrigins, username, and phone.
    // Plan 12i Task 6 adds anonymous.
    expect(exempt).toHaveLength(19);
    for (const m of exempt) {
      const f = (/ id="off-([^"]+)"/.exec(m[1] ?? "")?.[1] ?? "") as keyof typeof DEMO_EXEMPT;
      expect({ f, dt: textOf(m[2] ?? ""), dd: textOf(m[3] ?? "") }).toEqual({
        f,
        dt: FEATURES[f].title,
        dd: textOf(DEMO_EXEMPT[f]),
      });
    }
    // The five parts of the design that are no route feature, each with a reason.
    const fixed = rows
      .filter((m) => / class="off-fixed[ "]/.test(m[1] ?? ""))
      .map((m) => textOf(m[2] ?? ""));
    expect(fixed).toEqual([
      "The breach check",
      "The captcha",
      "The hooks",
      "The sweep",
      "The Better Auth compatibility instance",
    ]);
    expect(rows.every((m) => textOf(m[3] ?? "").endsWith("."))).toBe(true);
  });

  it("states the sandbox life of DEMO_LIMITS", () => {
    // The entry types "60 minutes" in its prose, so the test holds each such number to the facts.
    const life = DEMO_LIMITS.sandboxLifeMs / 60_000;
    const entry = readFileSync(`${SITE}src/content/site/demo.md`, "utf8");
    const said = [...entry.matchAll(/(\d+) minutes/g)].map((m) => Number(m[1]));
    // The description says it; the body leaves it to the limit row (one sentence, once).
    expect(said).toEqual([life]);
    const sentence = `The demo deletes each sandbox ${life} minutes after it starts.`;
    expect(textOf(main()).split(sentence)).toHaveLength(2);
  });

  it("states each limit of DEMO_LIMITS in words, with its number", () => {
    const limits = section("The limits");
    const rows = [...limits.matchAll(/<li\b[^>]* id="limit-([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
    expect(rows.map((m) => m[1])).toEqual([
      "sandboxesPerIp",
      "sandboxesTotal",
      "windowMs",
      "sandboxLifeMs",
      "usersPerSandbox",
      "passkeysPerSandbox",
      "tokensPerSandbox",
      "organizationsPerSandbox",
      "mailsKept",
      "bodyBytes",
      "requestsPerIpPerMinute",
    ]);
    const shown = (key: keyof typeof DEMO_LIMITS) => {
      const value = DEMO_LIMITS[key];
      return key === "windowMs" || key === "sandboxLifeMs" ? value / 60_000 : value;
    };
    for (const [, key = "", body = ""] of rows) {
      const k = key as keyof typeof DEMO_LIMITS;
      // The IPv6 note names a prefix length, not a limit.
      const words = textOf(body).replace(`An IPv6 address counts by its /${ipv6Prefix()}.`, "");
      const numbers = (words.match(/\d+/g) ?? []).map(Number);
      expect({ k, numbers }).toEqual({ k, numbers: [shown(k)] });
    }
    expect(textOf(rows[0]?.[2] ?? "")).toBe(
      `${DEMO_LIMITS.sandboxesPerIp} new sandboxes per address per hour. An IPv6 address counts by its /${ipv6Prefix()}.`,
    );
  });

  it("says that the hosted demo is not open while DEMO_PUBLISHED is false", () => {
    const end = main().split('<p class="end')[1]?.split("</p>")[0] ?? "";
    if (DEMO_PUBLISHED) {
      expect(end).toMatch(/<a\b[^>]* href="https:\/\/demo\.authtempo\.com\/"/);
      return;
    }
    expect(textOf(`<p${end}`)).toBe(
      "The hosted demo is not open yet. Run it on your machine: pnpm --filter @authtempo/demo dev",
    );
    expect(end).toMatch(/<code\b[^>]*>pnpm --filter @authtempo\/demo dev<\/code>/);
    // The address of the dev script (final review M1): the run sets DEMO_ORIGIN to it.
    const local = [...main().matchAll(/<p class="local\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) =>
      textOf(m[1] ?? ""),
    );
    expect(local).toEqual([
      "Then open this address in your browser: https://localhost:8787/",
      "The local run has its own certificate, so the browser asks you to accept it.",
    ]);
    expect(main()).toMatch(/<code\b[^>]*>https:\/\/localhost:8787\/<\/code>/);
    // No page claims a host that does not answer (deviation 11).
    expect(main()).not.toContain("demo.authtempo.com");
  });
});

describe("the data of the demo page (plan 11b Task 12, ruling 40)", () => {
  it("reads the IPv6 prefix from the key that core ipKey writes", () => {
    // Core keys an IPv6 address by its prefix; a change of core changes the page.
    expect(ipv6Prefix()).toBe(Number(/\/(\d+)$/.exec(ipKey("2001:db8::1"))?.[1]));
    expect(ipv6Prefix(() => "2001:db8::/48")).toBe(48);
    expect(() => ipv6Prefix(() => "2001:db8:1:2:3:4:5:6")).toThrow(/no prefix/);
  });

  it("links each demo guide under the docs of this site", () => {
    // The demo types no docs host: DOCS_BASE of its facts is the site origin and the docs path.
    expect(DOCS_BASE).toBe(`${SITE_NAMES.origin}${SITE_NAMES.docs.replace(/\/$/, "")}`);
    expect(DOCS_BASE).toBe("https://authtempo.com/docs");
  });

  it("ends with a link to the host when published, else with the local command", () => {
    expect(demoEnd(true)).toEqual({
      kind: "open",
      href: "https://demo.authtempo.com/",
      text: "Open the demo",
    });
    expect(demoEnd(false)).toEqual({
      kind: "closed",
      text: "The hosted demo is not open yet. Run it on your machine:",
      command: "pnpm --filter @authtempo/demo dev",
      thenOpen: "Then open this address in your browser:",
      address: "https://localhost:8787/",
      certificate: "The local run has its own certificate, so the browser asks you to accept it.",
    });
  });
});
