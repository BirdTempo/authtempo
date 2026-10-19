// Each script of package.json that runs astro starts with
// ASTRO_TELEMETRY_DISABLED=1. Astro telemetry sends an event to
// telemetry.astro.build on each run, and the build makes no network call
// beyond the registry. Astro reads the switch from the environment only
// (@astrojs/telemetry 3.3.3, read 2026-10-14). test/scripts.test.ts holds it.
import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { FRAMEWORK_PAGES } from "./frameworks.mjs";
import { parseTokens } from "./scripts/lib/tokens.ts";
import { SITE } from "./src/data/site.ts";

// One source for the paper color: the theme-color metas of the docs read tokens.css (brand spec 13).
const tokens = parseTokens(
  readFileSync(new URL("./src/styles/tokens.css", import.meta.url), "utf8"),
);

/**
 * The sidebar. Each content task of plan 11a adds its group. A group with
 * `autogenerate` lists the pages of one folder of src/content/docs.
 */
const sidebar = [
  { label: "Home", slug: "docs" },
  { label: "FAQ", slug: "docs/faq" },
  // Starlight 0.39 and later: a group has `items`, and `autogenerate` is an item.
  { label: "Getting started", items: [{ autogenerate: { directory: "docs/start" } }] },
  // Plan 11d2 Task 16 (Better Auth docs audit): the framework is the reader's
  // first choice. Each page here has sidebar.hidden, so it has one place.
  {
    label: "Frameworks",
    items: FRAMEWORK_PAGES.map(({ label, slug }) => ({ label, slug })),
  },
  { label: "How-to guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
  { label: "Migration", items: [{ autogenerate: { directory: "docs/migrate" } }] },
  { label: "Operations", items: [{ autogenerate: { directory: "docs/operations" } }] },
  { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
  { label: "Concepts", items: [{ autogenerate: { directory: "docs/concepts" } }] },
  {
    label: "Versions",
    items: [
      { label: "Versioning policy", slug: "docs/versioning" },
      { label: "Changelog", slug: "docs/changelog" },
    ],
  },
];

export default defineConfig({
  // The domain that the owner named (decision 1a of 2026-10-14). This plan
  // deploys to a preview only. The owner publishes the site on this domain.
  site: SITE.origin,
  // Every page builds to <path>/index.html. The Worker's assets answer such a
  // file at <path>/ and send <path> there (html_handling auto-trailing-slash,
  // Cloudflare docs read 2026-10-14). Every link in a page ends with /.
  trailingSlash: "always",
  build: { format: "directory" },
  // Starlight 0.42.6 turns Astro's prefetch on when this key is absent, and
  // Astro then puts its prefetch module script on every page (read 2026-10-19).
  // A root page holds one script, the theme toggle, and check-script fails on
  // any other (brand spec 12, decision 1). The docs pages lose hover prefetch.
  prefetch: false,
  vite: {
    // The pages import sample files of examples/ with ?raw. The dev server
    // serves files under its root only, unless this list allows them.
    server: { fs: { allow: ["../.."] } },
  },
  integrations: [
    starlight({
      title: "authtempo",
      sidebar,
      // Starlight reads the brand tokens (brand spec 11). The root pages import the same file in Site.astro.
      customCss: ["./src/styles/tokens.css", "./src/styles/docs.css"],
      // Brand spec 11. Each override keeps Starlight's behavior and reads its
      // props from Astro.locals.starlightRoute (Starlight 0.42.6).
      components: {
        SiteTitle: "./src/components/docs/SiteTitle.astro",
        ThemeSelect: "./src/components/docs/ThemeSelect.astro",
        Sidebar: "./src/components/docs/Sidebar.astro",
      },
      // One dark theme in both schemes: brand spec 4 gives a code block the
      // same ink in light and dark. The background is the code token, and the
      // frame has no border and no shadow. The frames plugin takes its editor
      // background from codeBackground. It takes the terminal, the title bar,
      // and the tab colors from the theme, so each one is set here.
      expressiveCode: {
        themes: ["starlight-dark"],
        useStarlightDarkModeSwitch: false,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          codeBackground: "var(--at-code)",
          codeFontFamily: "var(--at-font-mono)",
          borderWidth: "0px",
          frames: {
            frameBoxShadowCssValue: "none",
            terminalBackground: "var(--at-code)",
            terminalTitlebarBackground: "var(--at-code)",
            terminalTitlebarBorderBottomColor: "var(--at-line)",
            editorTabBarBackground: "var(--at-code)",
            editorTabBarBorderBottomColor: "var(--at-line)",
            editorActiveTabBackground: "var(--at-code)",
          },
        },
      },
      // Brand spec 13 on every docs page. Starlight already links /favicon.svg.
      head: [
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "link", attrs: { rel: "manifest", href: "/site.webmanifest" } },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            media: "(prefers-color-scheme: light)",
            content: tokens.light.get("--at-paper"),
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            media: "(prefers-color-scheme: dark)",
            content: tokens.darkAttr.get("--at-paper"),
          },
        },
        { tag: "meta", attrs: { property: "og:image", content: `${SITE.origin}/og.png` } },
      ],
    }),
  ],
});
