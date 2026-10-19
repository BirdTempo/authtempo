// Ruling 14 of the plan 11b lane: no deploy ships a dist without the written
// headers. wrangler.jsonc names this file as its build command, so wrangler
// runs it before each deploy, each dry run, and each dev start. It runs
// check-csp on dist: a dist from `astro build` alone still holds
// _headers.template and no _headers, and fails here. Run the package script
// `build`, which writes the headers, before a deploy.
import { existsSync, readFileSync } from "node:fs";
import { checkCsp } from "./check-csp.ts";
import { distFiles, distPages } from "./lib/load.ts";
import { DIST } from "./lib/paths.ts";
import { summaryLine } from "./lib/report.ts";

const headers = existsSync(`${DIST}_headers`) ? readFileSync(`${DIST}_headers`, "utf8") : null;
const report = checkCsp(distPages(), headers, distFiles());
console.log(`guard-deploy: ${summaryLine(report)}`);
for (const f of report.failures) console.error(`guard-deploy: ${f}`);
if (report.failures.length > 0) {
  console.error(
    "guard-deploy: FAIL run `pnpm --filter @authtempo/site build` first; it writes dist/_headers",
  );
  process.exit(1);
}
