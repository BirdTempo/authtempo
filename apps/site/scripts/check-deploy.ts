import { spawnSync } from "node:child_process";
import { SITE } from "./lib/paths.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** Runs `wrangler deploy --dry-run` on apps/site/wrangler.jsonc. It uploads nothing. */
export function wranglerDryRun(): { status: number | null; output: string } {
  const run = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run"], {
    cwd: SITE,
    encoding: "utf8",
    // The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_HIDE_BANNER: "true",
      NO_COLOR: "1",
    },
  });
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

/** The config test of the Worker: the dry run must exit 0. */
export function checkDeploy(run: () => { status: number | null; output: string }): CheckReport {
  const result = run();
  const r: CheckReport = { name: "check-deploy", counts: { runs: 1 }, failures: [] };
  if (result.status !== 0)
    r.failures.push(`wrangler deploy --dry-run exited ${result.status}: ${result.output}`);
  return requireCounts(r, ["runs"]);
}
