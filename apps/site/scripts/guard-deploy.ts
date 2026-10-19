// Ruling 14 of the plan 11b lane: no deploy ships a dist without the written
// headers. wrangler.jsonc names this file as its build command, so wrangler
// runs it before each deploy, each dry run, and each dev start. It runs
// check-csp on dist: a dist from `astro build` alone still holds
// _headers.template and no _headers, and fails here. It also runs check-feed,
// so a dist with no valid dist/feed.xml fails (plan 11b Task 7). Run the
// package script `build`, which writes the headers and the feed, before a deploy.
import { existsSync, readFileSync } from "node:fs";
import { FEED_START, RELEASE_DATES } from "../src/data/releases.ts";
import { REPO_ROOT } from "../src/data/repo.ts";
import { readChangelogs, readVersions } from "./lib/feed.ts";
import { guardReports } from "./lib/guard.ts";
import { distFiles, distPages } from "./lib/load.ts";
import { DIST } from "./lib/paths.ts";
import { summaryLine } from "./lib/report.ts";

const read = (file: string) =>
  existsSync(`${DIST}${file}`) ? readFileSync(`${DIST}${file}`, "utf8") : null;
const reports = guardReports({
  pages: distPages(),
  headers: read("_headers"),
  files: distFiles(),
  feed: {
    feed: read("feed.xml"),
    versions: readVersions(REPO_ROOT),
    changelogs: readChangelogs(REPO_ROOT),
    dates: RELEASE_DATES,
    start: FEED_START,
  },
});
for (const r of reports) console.log(`guard-deploy: ${summaryLine(r)}`);
const failures = reports.flatMap((r) => r.failures.map((f) => `${r.name}: ${f}`));
for (const f of failures) console.error(`guard-deploy: ${f}`);
if (failures.length > 0) {
  console.error(
    "guard-deploy: FAIL run `pnpm --filter @authtempo/site build` first; it writes dist/_headers and dist/feed.xml",
  );
  process.exit(1);
}
