// Each script of package.json that runs astro starts with
// ASTRO_TELEMETRY_DISABLED=1. Astro telemetry sends an event to
// telemetry.astro.build on each run, and the build makes no network call
// beyond the registry. Astro reads the switch from the environment only
// (@astrojs/telemetry 3.3.3, read 2026-10-14). test/scripts.test.ts holds it.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { FRAMEWORK_PAGES } from "./frameworks.mjs";

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
  site: "https://authtempo.com",
  // Every page builds to <path>/index.html. The Worker's assets answer such a
  // file at <path>/ and send <path> there (html_handling auto-trailing-slash,
  // Cloudflare docs read 2026-10-14). Every link in a page ends with /.
  trailingSlash: "always",
  build: { format: "directory" },
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
      customCss: ["./src/styles/tokens.css"],
    }),
  ],
});
