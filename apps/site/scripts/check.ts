// The site checks of plan 11a, on the real tree. `pnpm test` runs it after
// `astro build`, so every check that reads dist reads a build that is newer
// than the change. Each check prints one summary line. The run fails when one
// check fails, and the last line counts the checks that passed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_CHECK_CODES } from "@authtempo/cli";
import { COMPAT_MIGRATION_NAMES } from "@authtempo/compat-better-auth";
import { ERRORS, OAUTH_ERRORS, SCHEMA_VERSION } from "@authtempo/core";
import { ROUTES } from "@authtempo/core/routes";
import { checkAgentIndex, sampleIncludes } from "./check-agent-index.ts";
import { checkCli } from "./check-cli.ts";
import { checkConfig } from "./check-config.ts";
import { checkDeploy, wranglerDryRun } from "./check-deploy.ts";
import { checkErrorLinks, errorLinks } from "./check-error-links.ts";
import { checkErrors } from "./check-errors.ts";
import { checkExports, readExports } from "./check-exports.ts";
import { checkFaq, FAQ_PAGE, migrationGuides } from "./check-faq.ts";
import { checkFences } from "./check-fences.ts";
import { checkFrontmatter, pageUrl } from "./check-frontmatter.ts";
import { checkLinks } from "./check-links.ts";
import { checkLlms } from "./check-llms.ts";
import { checkMcp } from "./check-mcp.ts";
import { checkRoutes } from "./check-routes.ts";
import { checkSchema } from "./check-schema.ts";
import { checkSentences } from "./check-sentences.ts";
import { checkSize, sizesOf } from "./check-size.ts";
import { checkTerms } from "./check-terms.ts";
import { checkTokens } from "./check-tokens.ts";
import { sidebarGroups, sidebarOrder } from "./lib/agent.ts";
import { cliHelpPages, helpRuns } from "./lib/cli-help.ts";
import { configKeyPaths } from "./lib/config-keys.ts";
import { EXPORT_ENTRIES } from "./lib/entries.ts";
import {
  distFiles,
  distPageOrEmpty,
  distPages,
  docsPages,
  readRepoFile,
  readSiteFile,
  sampleFiles,
  siteSources,
} from "./lib/load.ts";
import { wireLists } from "./lib/mcp-wire.ts";
import { DIST, DOCS, REPO } from "./lib/paths.ts";
import { type CheckReport, summaryLine } from "./lib/report.ts";

/** A file of dist, or "" when the build did not write it. The check then fails on what it lacks. */
function distText(file: string): string {
  return existsSync(`${DIST}${file}`) ? readFileSync(`${DIST}${file}`, "utf8") : "";
}

/** The built MCP server. The site's Turbo test builds it first, through the dev dependency. */
const MCP_BIN = `${REPO}packages/mcp/dist/bin/authtempo-mcp.js`;

// check-mcp reads the server on the wire (plan 11e deviation 15). The reads
// are async, so they run once here, before the checks. A failed read is an
// error of the answer, and check-mcp fails on it.
const mcpWire = await wireLists(MCP_BIN, `${DIST}agent/index.json`);

export const CHECKS: { name: string; run: () => CheckReport }[] = [
  { name: "check-links", run: () => checkLinks(distPages(), distFiles()) },
  { name: "check-frontmatter", run: () => checkFrontmatter(docsPages(), readRepoFile) },
  // The help texts of the CLI keep the same terms and sentence limits as the pages (plan 11c).
  { name: "check-terms", run: () => checkTerms([...docsPages(), ...cliHelpPages()]) },
  { name: "check-sentences", run: () => checkSentences([...docsPages(), ...cliHelpPages()]) },
  { name: "check-fences", run: () => checkFences(docsPages(), sampleFiles(), existsSync) },
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
    name: "check-errors",
    run: () => checkErrors(distPageOrEmpty("/docs/reference/errors/"), ERRORS, OAUTH_ERRORS),
  },
  {
    name: "check-error-links",
    run: () => checkErrorLinks(errorLinks(), distPageOrEmpty),
  },
  {
    name: "check-routes",
    run: () => checkRoutes(distPageOrEmpty("/docs/reference/routes/"), ROUTES),
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
    // Brand spec 4 and 14. Task 6 passes the favicon; until then it is the placeholder of plan 11a.
    name: "check-tokens",
    run: () =>
      checkTokens({
        css: readSiteFile("src/styles/tokens.css") ?? "",
        sources: siteSources(),
        favicon: null,
      }),
  },
  { name: "check-size", run: () => checkSize(sizesOf(DIST)) },
  { name: "check-deploy", run: () => checkDeploy(wranglerDryRun) },
];

const reports = CHECKS.map((c) => c.run());
for (const r of reports) console.log(summaryLine(r));
for (const r of reports) for (const e of r.exempt ?? []) console.log(`  exempt ${r.name}: ${e}`);
const failed = reports.filter((r) => r.failures.length > 0);
for (const r of failed) for (const f of r.failures) console.error(`${r.name}: ${f}`);
console.log(`site checks: ${reports.length - failed.length} of ${reports.length} passed`);
if (failed.length > 0) process.exit(1);
