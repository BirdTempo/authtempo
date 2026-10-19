import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardReports } from "../scripts/lib/guard.ts";
import { SITE } from "../scripts/lib/paths.ts";

// Ruling 14 of the plan 11b lane: wrangler runs the build command before each
// deploy and dry run. The guard fails a dist without the written headers, so
// `astro build` then `wrangler deploy` cannot ship a site with no CSP.
describe("the deploy guard", () => {
  it("is the build command of wrangler.jsonc", () => {
    const config = readFileSync(`${SITE}wrangler.jsonc`, "utf8");
    const commands = [...config.matchAll(/^\s*"build":\s*\{\s*"command":\s*"([^"]*)"\s*\}/gm)].map(
      (m) => m[1],
    );
    expect(commands).toEqual(["node scripts/guard-deploy.ts"]);
  });

  // Review of Task 7, Low 3: build-feed.ts can fail after write-headers.ts.
  // That dist has the headers and no feed, and the guard must stop its deploy.
  it("runs check-csp and check-feed, and fails a dist with no feed", () => {
    const reports = guardReports({
      pages: new Map(),
      headers: null,
      files: new Set(),
      feed: {
        feed: null,
        versions: [{ pkg: "@authtempo/core", version: "0.0.0" }],
        changelogs: [],
        dates: {},
        start: "2026-10-14T00:00:00Z",
      },
    });
    expect(reports.map((r) => r.name)).toEqual(["check-csp", "check-feed"]);
    expect(reports[1]?.failures).toEqual(["dist/feed.xml is missing"]);
  });
});
