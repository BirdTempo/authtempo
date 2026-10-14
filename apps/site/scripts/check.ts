// The site checks of plan 11a, on the real tree. `pnpm test` runs it after
// `astro build`, so every check that reads dist reads a build that is newer
// than the change. Each check prints one summary line. The run fails when one
// check fails, and the last line counts the checks that passed.
import { existsSync } from "node:fs";
import { ALL_CHECK_CODES } from "@authtempo/cli";
import { ERRORS, OAUTH_ERRORS } from "@authtempo/core";
import { ROUTES } from "@authtempo/core/testing";
import { checkCli } from "./check-cli.ts";
import { checkConfig } from "./check-config.ts";
import { checkDeploy, wranglerDryRun } from "./check-deploy.ts";
import { checkErrors } from "./check-errors.ts";
import { checkExports, readExports } from "./check-exports.ts";
import { checkFences } from "./check-fences.ts";
import { checkFrontmatter, pageUrl } from "./check-frontmatter.ts";
import { checkLinks } from "./check-links.ts";
import { checkRoutes } from "./check-routes.ts";
import { checkSentences } from "./check-sentences.ts";
import { checkSize, sizesOf } from "./check-size.ts";
import { checkTerms } from "./check-terms.ts";
import { cliHelpPages, helpRuns } from "./lib/cli-help.ts";
import { configKeyPaths } from "./lib/config-keys.ts";
import {
  distFiles,
  distPageOrEmpty,
  distPages,
  docsPages,
  readRepoFile,
  sampleFiles,
} from "./lib/load.ts";
import { DIST } from "./lib/paths.ts";
import { type CheckReport, summaryLine } from "./lib/report.ts";

export const CHECKS: { name: string; run: () => CheckReport }[] = [
  { name: "check-links", run: () => checkLinks(distPages(), distFiles()) },
  { name: "check-frontmatter", run: () => checkFrontmatter(docsPages(), readRepoFile) },
  // The help texts of the CLI keep the same terms and sentence limits as the pages (plan 11c).
  { name: "check-terms", run: () => checkTerms([...docsPages(), ...cliHelpPages()]) },
  { name: "check-sentences", run: () => checkSentences([...docsPages(), ...cliHelpPages()]) },
  { name: "check-fences", run: () => checkFences(docsPages(), sampleFiles(), existsSync) },
  {
    name: "check-errors",
    run: () => checkErrors(distPageOrEmpty("/docs/reference/errors/"), ERRORS, OAUTH_ERRORS),
  },
  {
    name: "check-routes",
    run: () => checkRoutes(distPageOrEmpty("/docs/reference/routes/"), ROUTES),
  },
  {
    name: "check-config",
    run: () => checkConfig(distPageOrEmpty("/docs/reference/config/"), configKeyPaths()),
  },
  {
    name: "check-exports-core",
    run: () =>
      checkExports(
        distPageOrEmpty("/docs/reference/api/"),
        readExports(readRepoFile("packages/core/src/index.ts") ?? "", "packages/core/src/index.ts"),
        "core",
      ),
  },
  {
    name: "check-exports-client",
    run: () =>
      checkExports(
        distPageOrEmpty("/docs/reference/client/"),
        readExports(
          readRepoFile("packages/client/src/index.ts") ?? "",
          "packages/client/src/index.ts",
        ),
        "client",
      ),
  },
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
