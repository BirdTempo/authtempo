// Plan 11b Task 7. Each script that builds runs this right after
// write-headers.ts. It writes dist/feed.xml, the Atom feed of the version
// headings of each packages/*/CHANGELOG.md (spec 24 item 6). Each entry takes
// its date from RELEASE_DATES (ruling 29 of the plan 11b lane). So the feed
// holds no build time and no git commit, and a cached build is byte-equal to
// a fresh one. The root comes from src/data/repo.ts (ruling 24), never
// from the working folder. turbo.json hashes each file it reads.
import { existsSync, writeFileSync } from "node:fs";
import { FEED_START, RELEASE_DATES } from "../src/data/releases.ts";
import { REPO_ROOT } from "../src/data/repo.ts";
import { atomFeed, datedEntries, feedUpdated, readChangelogs, releaseEntries } from "./lib/feed.ts";
import { DIST } from "./lib/paths.ts";

if (!existsSync(DIST)) {
  console.error("build-feed: FAIL dist/ is missing; run astro build first");
  process.exit(1);
}
try {
  const changelogs = readChangelogs(REPO_ROOT);
  const { dated, missing } = datedEntries(releaseEntries(changelogs), RELEASE_DATES);
  if (missing.length > 0)
    throw new Error(`${missing.join(", ")}: no row of RELEASE_DATES in src/data/releases.ts`);
  writeFileSync(`${DIST}feed.xml`, atomFeed(dated, feedUpdated(dated, FEED_START)));
  console.log(`build-feed: PASS entries=${dated.length} changelogs=${changelogs.length}`);
} catch (e) {
  console.error(`build-feed: FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
