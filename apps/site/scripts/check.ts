// The site checks of plan 11a, on the real tree. `pnpm test` runs it after
// `astro build`, so every check that reads dist reads a build that is newer
// than the change. Each check prints one summary line. The run fails when one
// check fails, and the last line counts the checks that passed.
import { existsSync } from "node:fs";
import { checkDeploy, wranglerDryRun } from "./check-deploy.ts";
import { checkFences } from "./check-fences.ts";
import { checkFrontmatter } from "./check-frontmatter.ts";
import { checkLinks } from "./check-links.ts";
import { checkSentences } from "./check-sentences.ts";
import { checkSize, sizesOf } from "./check-size.ts";
import { checkTerms } from "./check-terms.ts";
import { distFiles, distPages, docsPages, readRepoFile, sampleFiles } from "./lib/load.ts";
import { DIST } from "./lib/paths.ts";
import { type CheckReport, summaryLine } from "./lib/report.ts";

export const CHECKS: { name: string; run: () => CheckReport }[] = [
  { name: "check-links", run: () => checkLinks(distPages(), distFiles()) },
  { name: "check-frontmatter", run: () => checkFrontmatter(docsPages(), readRepoFile) },
  { name: "check-terms", run: () => checkTerms(docsPages()) },
  { name: "check-sentences", run: () => checkSentences(docsPages()) },
  { name: "check-fences", run: () => checkFences(docsPages(), sampleFiles(), existsSync) },
  { name: "check-size", run: () => checkSize(sizesOf(DIST)) },
  { name: "check-deploy", run: () => checkDeploy(wranglerDryRun) },
];

const reports = CHECKS.map((c) => c.run());
for (const r of reports) console.log(summaryLine(r));
const failed = reports.filter((r) => r.failures.length > 0);
for (const r of failed) for (const f of r.failures) console.error(`${r.name}: ${f}`);
console.log(`site checks: ${reports.length - failed.length} of ${reports.length} passed`);
if (failed.length > 0) process.exit(1);
