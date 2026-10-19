import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
