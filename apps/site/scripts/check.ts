// The site checks of plan 11a, on the real tree. `pnpm test` runs it after
// `astro build`, so every check that reads dist reads a build that is newer
// than the change. Each check prints one summary line. The run fails when one
// check fails, and the last line counts the checks that passed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_CHECK_CODES } from "@authtempo/cli";
import { PROVIDERS } from "@authtempo/cli/program";
import { COMPAT_MIGRATION_NAMES } from "@authtempo/compat-better-auth";
import { ERRORS, OAUTH_ERRORS, SCHEMA_VERSION } from "@authtempo/core";
import { STORAGE_ERROR_CODES } from "@authtempo/core/errors";
import { EVENTS, LIMIT_FAMILIES } from "@authtempo/core/observe";
import { openApiDocument, openApiJson, openApiReferenceOptions } from "@authtempo/core/openapi";
import { FIELD_KINDS } from "@authtempo/core/redact";
import { ROUTES } from "@authtempo/core/routes";
import { CONFLICT_REASONS, PROVIDER_FILES } from "@authtempo/import";
import { readChangelogFiles } from "../src/data/changelogs.ts";
import { COMPARE_ROWS, HOSTED_MODELS, otherNames } from "../src/data/compare.ts";
import { FEATURES, PACKAGE_EXEMPT, PACKAGE_FEATURES } from "../src/data/features.ts";
import { ICON_NAMES } from "../src/data/icons.ts";
import { FEED_START, RELEASE_DATES } from "../src/data/releases.ts";
import { REPO_ROOT } from "../src/data/repo.ts";
import { SITE } from "../src/data/site.ts";
import {
  CHANGELOG_EMPTY,
  PRE_RELEASE_EXEMPT,
  PRE_RELEASE_PATTERN,
  PRE_RELEASE_SENTENCES,
  REGISTRY_INSTALL,
  RESOURCES_EMPTY,
  UNPUBLISHED_PAGES,
} from "../src/data/unpublished.ts";
import { checkAgentIndex, sampleIncludes } from "./check-agent-index.ts";
import { checkChangelog } from "./check-changelog.ts";
import { checkClaims } from "./check-claims.ts";
import { checkCli } from "./check-cli.ts";
import { checkCompare } from "./check-compare.ts";
import { checkConfig } from "./check-config.ts";
import { checkContrast } from "./check-contrast.ts";
import { checkCsp } from "./check-csp.ts";
import { checkDependenciesPage, type DependencyRow } from "./check-dependencies-page.ts";
import { checkDeploy, wranglerDryRun } from "./check-deploy.ts";
import { checkDeprecationsPage, type RegisterEntry } from "./check-deprecations-page.ts";
import { checkErrorLinks, errorLinks } from "./check-error-links.ts";
import { checkErrors } from "./check-errors.ts";
import { checkEvents } from "./check-events.ts";
import { checkExports, readExports } from "./check-exports.ts";
import { checkExternal } from "./check-external.ts";
import { checkFacts } from "./check-facts.ts";
import { checkFaq, FAQ_PAGE, migrationGuides } from "./check-faq.ts";
import { checkFeatures } from "./check-features.ts";
import { checkFeed } from "./check-feed.ts";
import { checkFences } from "./check-fences.ts";
import { checkFonts } from "./check-fonts.ts";
import { checkFrontmatter, pageUrl } from "./check-frontmatter.ts";
import { checkIcons } from "./check-icons.ts";
import { checkLimits, DYNAMIC_LIMITS } from "./check-limits.ts";
import { checkLinks } from "./check-links.ts";
import { checkLlms } from "./check-llms.ts";
import { checkMcp } from "./check-mcp.ts";
import { checkMigrate } from "./check-migrate.ts";
import { checkMotion } from "./check-motion.ts";
import { checkOpenApi } from "./check-openapi.ts";
import {
  checkObserveTiming,
  checkPerformance,
  OBSERVE_TIMING_DATA,
  type ObserveTimingData,
  PERFORMANCE_DATA,
  PERFORMANCE_PAGE,
  type PerformanceData,
} from "./check-performance.ts";
import { checkPolicyPages, readPolicyPagesInput } from "./check-policy-pages.ts";
import { checkPreRelease } from "./check-pre-release.ts";
import { checkResources } from "./check-resources.ts";
import { checkRoutes } from "./check-routes.ts";
import { checkSchema } from "./check-schema.ts";
import { checkScript } from "./check-script.ts";
import { checkSecurityPolicy, readPolicyInput } from "./check-security-policy.ts";
import { checkSentences } from "./check-sentences.ts";
import { checkSitePages, MINIMUM_ENTRIES } from "./check-site-pages.ts";
import { checkSize, sizesOf } from "./check-size.ts";
import { checkTerms } from "./check-terms.ts";
import { checkTokens } from "./check-tokens.ts";
import { checkUnpublished } from "./check-unpublished.ts";
import { checkWeight } from "./check-weight.ts";
import { sidebarGroups, sidebarOrder } from "./lib/agent.ts";
import { helpRuns } from "./lib/cli-help.ts";
import { configKeyPaths } from "./lib/config-keys.ts";
import { EXPORT_ENTRIES } from "./lib/entries.ts";
import { readChangelogs, readVersions } from "./lib/feed.ts";
import { coreSources, limitWindows } from "./lib/limit-windows.ts";
import {
  distFiles,
  distPageOrEmpty,
  distPages,
  distRead,
  distSvgs,
  distTexts,
  docsPages,
  fontDir,
  packageFolders,
  readFontManifest,
  readRepoFile,
  readSiteFile,
  rootPages,
  sampleFiles,
  sitePages,
  siteSources,
} from "./lib/load.ts";
import { wireLists } from "./lib/mcp-wire.ts";
import { DIST, DOCS, REPO } from "./lib/paths.ts";
import { prosePages } from "./lib/prose.ts";
import { type CheckReport, summaryLine } from "./lib/report.ts";
import { trackedFiles } from "./lib/tracked.ts";

/** A file of dist, or "" when the build did not write it. The check then fails on what it lacks. */
function distText(file: string): string {
  return existsSync(`${DIST}${file}`) ? readFileSync(`${DIST}${file}`, "utf8") : "";
}

/** The site's OpenAPI document in dist (plan 11g). */
const OPENAPI_FILE = "docs/reference/openapi.json";

/** The parsed document of dist, or null when the build did not write it or it is not JSON. */
function openApiFile(): unknown {
  try {
    return JSON.parse(distText(OPENAPI_FILE)) as unknown;
  } catch {
    return null;
  }
}

/** dist/_headers as write-headers.ts wrote it, or null when the build lacks it (plan 11b Task 3). */
function distHeaders(): string | null {
  return existsSync(`${DIST}_headers`) ? readFileSync(`${DIST}_headers`, "utf8") : null;
}

/** The size of a file of dist by its URL path, such as /_astro/x.css, or null when it does not exist. */
function distBytes(path: string): number | null {
  const abs = `${DIST}${decodeURIComponent(path).slice(1)}`;
  return existsSync(abs) && statSync(abs).isFile() ? statSync(abs).size : null;
}

/** A JSON file of the repository, or null when it is missing or not JSON. */
function repoJson(path: string): unknown {
  try {
    const text = readRepoFile(path);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * The release facts that the checks of plan 12j Task 13 read: the version of
 * core (the group version), the released names (fixed[0] of the Changesets
 * config), the repository url, and each example folder whose package
 * release/unreleased.json names. A missing file gives an empty value, and
 * each check then fails on what it lacks.
 */
function releaseFacts(): {
  version: string;
  released: string[];
  repoUrl: string;
  examples: string[];
} {
  const core = repoJson("packages/core/package.json") as { version?: string } | null;
  const config = repoJson(".changeset/config.json") as { fixed?: string[][] } | null;
  const repo = repoJson("release/repository.json") as { url?: string } | null;
  const unreleased = Object.keys((repoJson("release/unreleased.json") ?? {}) as object);
  const examples = existsSync(`${REPO}examples`)
    ? readdirSync(`${REPO}examples`)
        .filter((folder) => {
          const pkg = repoJson(`examples/${folder}/package.json`) as { name?: string } | null;
          return pkg?.name !== undefined && unreleased.includes(pkg.name);
        })
        .sort()
    : [];
  return {
    version: core?.version ?? "",
    released: config?.fixed?.[0] ?? [],
    repoUrl: repo?.url ?? "",
    examples,
  };
}

/** The built MCP server. The site's Turbo test builds it first, through the dev dependency. */
const MCP_BIN = `${REPO}packages/mcp/dist/bin/authtempo-mcp.js`;

// check-mcp reads the server on the wire (plan 11e deviation 15). The reads
// are async, so they run once here, before the checks. A failed read is an
// error of the answer, and check-mcp fails on it.
const mcpWire = await wireLists(MCP_BIN, `${DIST}agent/index.json`);

export const CHECKS: { name: string; run: () => CheckReport }[] = [
  {
    // The SVG files join the pages, so each <use href> of an icon must name a symbol of the sprite (plan 11b1).
    name: "check-links",
    run: () => checkLinks(new Map([...distPages(), ...distSvgs()]), distFiles()),
  },
  { name: "check-frontmatter", run: () => checkFrontmatter(docsPages(), readRepoFile) },
  // Each root page has the layout and its entry of the collection `site` (plan 11b).
  // The row names MINIMUM_ENTRIES, so it is the one tie to ruling 9 of the plan 11b lane.
  {
    name: "check-site-pages",
    run: () => checkSitePages(sitePages(), rootPages(), MINIMUM_ENTRIES),
  },
  // The help texts of the CLI keep the same terms and sentence limits as the pages (plan 11c).
  // The home prose keeps the docs rules (brand spec 2; plan 11b1), and so do the
  // entries of the collection `site` (plan 11b). prosePages() is the one list.
  { name: "check-terms", run: () => checkTerms(prosePages()) },
  { name: "check-sentences", run: () => checkSentences(prosePages()) },
  {
    name: "check-fences",
    run: () => checkFences(docsPages(), sampleFiles(), existsSync, (p) => readFileSync(p, "utf8")),
  },
  // The agent files of plan 11e. llms.txt, llms-full.txt, and the .md twins list every page.
  // The agent index holds the tree, its anchors, its samples, and the bodies of the twins.
  {
    name: "check-llms",
    run: () => {
      const home = distPageOrEmpty("/docs/");
      return checkLlms(
        distFiles(),
        distText("llms.txt"),
        distText("llms-full.txt"),
        docsPages(),
        home === "" ? [] : sidebarOrder(home),
        home === "" ? {} : sidebarGroups(home),
      );
    },
  },
  {
    name: "check-agent-index",
    run: () =>
      checkAgentIndex(
        distText("agent/index.json"),
        docsPages(),
        distPages(),
        sampleIncludes(docsPages(), (path) => readFileSync(resolve(DOCS, path), "utf8")),
        (file) => (existsSync(`${DIST}${file}`) ? readFileSync(`${DIST}${file}`, "utf8") : null),
      ),
  },
  // The FAQ answers the questions of the migration guides, and each guide has an
  // entry that links it, so a new guide fails here until the FAQ covers it (plan 11d2).
  {
    name: "check-faq",
    run: () =>
      checkFaq(
        docsPages().find((p) => p.path === FAQ_PAGE)?.source ?? "",
        migrationGuides(docsPages()),
      ),
  },
  {
    // The Routes cell of each code holds to ROUTES (12i follow-up (1), plan 12n).
    name: "check-errors",
    run: () =>
      checkErrors(
        distPageOrEmpty("/docs/reference/errors/"),
        ERRORS,
        OAUTH_ERRORS,
        STORAGE_ERROR_CODES,
        ROUTES,
      ),
  },
  {
    name: "check-error-links",
    run: () => checkErrorLinks(errorLinks(), distPageOrEmpty),
  },
  {
    // The Input cells read the built document; check-openapi holds its bytes to the generator (plan 11g).
    name: "check-routes",
    run: () => checkRoutes(distPageOrEmpty("/docs/reference/routes/"), ROUTES, openApiFile()),
  },
  {
    name: "check-openapi",
    run: () =>
      checkOpenApi(
        existsSync(`${DIST}${OPENAPI_FILE}`) ? distText(OPENAPI_FILE) : null,
        openApiJson(openApiDocument(openApiReferenceOptions())),
        distPageOrEmpty("/docs/reference/openapi/"),
        ROUTES.length,
      ),
  },
  // Plan 12h Task 13: the events page and the default lines against EVENTS,
  // and the limits page against LIMIT_FAMILIES, one source each.
  {
    name: "check-events",
    run: () =>
      checkEvents(
        distPageOrEmpty("/docs/operations/observability/"),
        distPageOrEmpty("/docs/reference/events/"),
        EVENTS,
        Object.keys(FIELD_KINDS),
      ),
  },
  {
    name: "check-limits",
    run: () =>
      checkLimits(
        distPageOrEmpty("/docs/reference/limits/"),
        LIMIT_FAMILIES,
        limitWindows(coreSources(), DYNAMIC_LIMITS),
      ),
  },
  {
    name: "check-config",
    run: () => checkConfig(distPageOrEmpty("/docs/reference/config/"), configKeyPaths()),
  },
  // One export check per SDK entry (plan 11d): each export is a row of the entry's own
  // exports tables, and each row of those tables is an export of the entry.
  ...EXPORT_ENTRIES.map((e) => ({
    name: `check-exports-${e.label}`,
    run: () =>
      checkExports(
        distPageOrEmpty(e.page),
        readExports(readRepoFile(e.source) ?? "", e.source),
        e.label,
        e.headings,
      ),
  })),
  {
    name: "check-cli",
    run: () =>
      checkCli(
        distFiles(),
        distPageOrEmpty("/docs/reference/cli/check/"),
        helpRuns(),
        ALL_CHECK_CODES,
        (url) => docsPages().find((p) => pageUrl(p.path) === url)?.source ?? null,
      ),
  },
  {
    // Hold the guides to the shape of spec 23 item 9, the importer's readers, and the conflict anchors (plan 11f).
    name: "check-migrate",
    run: () =>
      checkMigrate(
        docsPages(),
        Object.keys(PROVIDER_FILES),
        distPageOrEmpty("/docs/reference/cli/import/"),
        CONFLICT_REASONS,
      ),
  },
  {
    // The MCP reference page against what the built server answers, both ways
    // (plan 11e Task 17): tools, inputs, hints, prompts, template, and limits.
    name: "check-mcp",
    run: () =>
      checkMcp(
        docsPages().find((p) => pageUrl(p.path) === "/docs/reference/mcp/")?.source ?? "",
        mcpWire,
      ),
  },
  {
    // One source for the version of core and the compat migrations, on the schema page and the Better Auth guide (plan 12c).
    name: "check-schema",
    run: () =>
      checkSchema(
        distPageOrEmpty("/docs/reference/schema/"),
        SCHEMA_VERSION,
        COMPAT_MIGRATION_NAMES,
        distPageOrEmpty("/docs/migrate/better-auth/"),
      ),
  },
  {
    // Brand spec 4 and 14. The favicon reads no token; its colors must be the ink and the accent.
    name: "check-tokens",
    run: () =>
      checkTokens({
        css: readSiteFile("src/styles/tokens.css") ?? "",
        sources: siteSources(),
        favicon: readSiteFile("public/favicon.svg"),
      }),
  },
  {
    // Brand spec 4 and 14: each pair at build time, by the WCAG 2.1 formula.
    name: "check-contrast",
    run: () => checkContrast(readSiteFile("src/styles/tokens.css") ?? ""),
  },
  {
    // Brand spec 5: five self-hosted subsets, their licenses, and no font host in the build.
    name: "check-fonts",
    run: () => {
      const fonts = fontDir();
      return checkFonts({
        manifest: readFontManifest(),
        fontDir: fonts.files,
        fontFolders: fonts.folders,
        tokensCss: readSiteFile("src/styles/tokens.css") ?? "",
        built: distTexts(),
        distFiles: distFiles(),
      });
    },
  },
  {
    // Brand spec 7 and 14: motion in tokens.css only, at rest under reduced motion, on every page.
    name: "check-motion",
    run: () =>
      checkMotion({
        tokensCss: readSiteFile("src/styles/tokens.css") ?? "",
        sources: siteSources(),
        pages: distPages(),
        read: distRead,
      }),
  },
  {
    // Brand spec 8: one grid for every icon.
    name: "check-icons",
    run: () => checkIcons(readSiteFile("public/icons.svg") ?? "", ICON_NAMES),
  },
  {
    // Brand spec 12: one hashed inline script on the root pages, and no other.
    name: "check-script",
    run: () =>
      checkScript({
        toggle: readSiteFile("src/scripts/theme-toggle.js") ?? "",
        rootPages: rootPages(),
      }),
  },
  // Plan 11b Task 3: no page loads a file of another origin, and the site sets no cookie.
  {
    name: "check-external",
    run: () =>
      checkExternal(
        distPages(),
        distHeaders(),
        new Map([...distTexts()].filter(([path]) => path.endsWith(".css"))),
      ),
  },
  // The CSP that write-headers.ts wrote, held to the inline scripts of this build.
  { name: "check-csp", run: () => checkCsp(distPages(), distHeaders(), distFiles()) },
  { name: "check-weight", run: () => checkWeight(rootPages(), distBytes) },
  // Plan 11b Task 4: each route feature and each package folder has its section on /features/.
  {
    name: "check-features",
    run: () =>
      checkFeatures({
        folders: packageFolders(),
        built: distPageOrEmpty("/features/"),
        files: distFiles(),
        read: (file) => distText(file) || null,
        features: FEATURES,
        routes: ROUTES,
        packages: PACKAGE_FEATURES,
        exempt: PACKAGE_EXEMPT,
      }),
  },
  // Plan 11b Task 6: each fact of /compare/ has a source, and a read date at most FACT_MAX_DAYS old.
  // `today` is the build time, so a fact grows old with no change of the tree.
  // Spec 24 item 4 on each root page but /compare/ (final review m1 of plan
  // 11b). The demo pages are not in the build: the demo prose test runs the same rule.
  {
    name: "check-claims",
    run: () =>
      checkClaims({
        pages: new Map([...rootPages()].filter(([path]) => path !== "compare/index.html")),
        names: otherNames(),
      }),
  },
  {
    name: "check-facts",
    run: () =>
      checkFacts({
        rows: COMPARE_ROWS,
        models: HOSTED_MODELS,
        providers: PROVIDERS,
        built: distPageOrEmpty("/compare/"),
        files: distFiles(),
        // Outside a git checkout this is an error, and check-facts fails with it (re-review R1).
        tracked: trackedFiles(REPO),
        today: new Date(),
      }),
  },
  // Ruling 55 of plan 12e. An authtempo cell of /compare/ can deny a route or a
  // config key. It fails while ROUTES or the config keys hold that fact.
  {
    name: "check-compare",
    run: () => checkCompare({ rows: COMPARE_ROWS, routes: ROUTES, keys: configKeyPaths() }),
  },
  // Plan 11b Task 7: the feed of dist is valid Atom, with one entry per version
  // heading and one row of RELEASE_DATES each. The root comes from repo.ts (ruling 24).
  {
    name: "check-feed",
    run: () =>
      checkFeed({
        feed: existsSync(`${DIST}feed.xml`) ? distText("feed.xml") : null,
        versions: readVersions(REPO_ROOT),
        changelogs: readChangelogs(REPO_ROOT),
        dates: RELEASE_DATES,
        start: FEED_START,
      }),
  },
  // Plan 12j Task 12: SECURITY.md against release/support.json, release/repository.json,
  // and owner decision 4. A file that the check could not read is a failure.
  {
    name: "check-security-policy",
    run: () => {
      const input = readPolicyInput(readRepoFile);
      const r = checkSecurityPolicy({
        text: input.text ?? "",
        rows: input.rows,
        repository: input.repository,
        origin: SITE.origin,
      });
      r.failures.unshift(...input.failures);
      return r;
    },
  },
  // Plan 12j Task 13a: each fact of the versioning page and the security
  // policy page against its source. A file that the check could not read is a failure.
  {
    name: "check-policy-pages",
    run: () => {
      const read = readPolicyPagesInput(readRepoFile);
      const r = checkPolicyPages(read.input);
      r.failures.unshift(...read.failures);
      return r;
    },
  },
  // Plan 12j Task 13: the notes before the first release, the changelog page,
  // the deprecation register, the dependency list, and the Resources page.
  {
    name: "check-unpublished",
    run: () =>
      checkUnpublished({
        version: releaseFacts().version,
        pages: docsPages(),
        listed: UNPUBLISHED_PAGES,
        install: REGISTRY_INSTALL,
      }),
  },
  // Review M2 and L7 of plan 12j Task 13b: each text that holds only before
  // the first release, against the version of core, both ways.
  {
    name: "check-pre-release",
    run: () =>
      checkPreRelease({
        version: releaseFacts().version,
        listed: PRE_RELEASE_SENTENCES,
        read: readRepoFile,
        pages: docsPages(),
        pattern: PRE_RELEASE_PATTERN,
        exempt: PRE_RELEASE_EXEMPT,
      }),
  },
  {
    name: "check-changelog",
    run: () =>
      checkChangelog({
        changelogs: readChangelogFiles(REPO_ROOT),
        page: distPageOrEmpty("/docs/changelog/"),
        repoUrl: releaseFacts().repoUrl,
        empty: CHANGELOG_EMPTY,
      }),
  },
  {
    name: "check-deprecations-page",
    run: () =>
      checkDeprecationsPage({
        register: (repoJson("release/deprecations.json") ?? []) as RegisterEntry[],
        source: readRepoFile("apps/site/src/content/docs/docs/reference/deprecations.md") ?? "",
        built: distPageOrEmpty("/docs/reference/deprecations/"),
      }),
  },
  {
    name: "check-dependencies-page",
    run: () =>
      checkDependenciesPage({
        rows: (repoJson("release/dependencies.json") ?? []) as DependencyRow[],
        released: releaseFacts().released,
        source: readRepoFile("apps/site/src/content/docs/docs/reference/dependencies.md") ?? "",
      }),
  },
  {
    name: "check-resources",
    run: () => {
      const facts = releaseFacts();
      return checkResources({
        ...facts,
        source: readRepoFile("apps/site/src/content/docs/docs/resources.md") ?? "",
        empty: RESOURCES_EMPTY,
      });
    },
  },
  { name: "check-size", run: () => checkSize(sizesOf(DIST)) },
  { name: "check-deploy", run: () => checkDeploy(wranglerDryRun) },
  // The record of the performance run and the block of its page (plan 12h Task 15).
  // The load rule reads the cores of the machine that ran it, from the record.
  {
    name: "check-performance",
    run: () => {
      const data = JSON.parse(readSiteFile(PERFORMANCE_DATA) ?? "{}") as PerformanceData;
      const page = docsPages().find((p) => p.path === PERFORMANCE_PAGE)?.source ?? "";
      return checkPerformance(page, data, data.machine?.cores ?? 0);
    },
  },
  // The record of the observer timing run (ruling 3 q3 of plan 12h) and its block.
  {
    name: "check-observe-timing",
    run: () => {
      const timing = JSON.parse(readSiteFile(OBSERVE_TIMING_DATA) ?? "{}") as ObserveTimingData;
      const page = docsPages().find((p) => p.path === PERFORMANCE_PAGE)?.source ?? "";
      return checkObserveTiming(page, timing);
    },
  },
];

const reports = CHECKS.map((c) => c.run());
for (const r of reports) console.log(summaryLine(r));
for (const r of reports) for (const e of r.exempt ?? []) console.log(`  exempt ${r.name}: ${e}`);
const failed = reports.filter((r) => r.failures.length > 0);
for (const r of failed) for (const f of r.failures) console.error(`${r.name}: ${f}`);
console.log(`site checks: ${reports.length - failed.length} of ${reports.length} passed`);
if (failed.length > 0) process.exit(1);
