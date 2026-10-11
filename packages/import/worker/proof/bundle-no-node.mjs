// The bundle check of the import D1 Worker with Node.js compatibility off
// (plan 9b, final review M-3).
//
// The vitest pool turns Node.js modules on for its own runner whatever the
// flags say (@cloudflare/vitest-plugin 1.4.0, dist/pool/index.mjs, read
// 2026-10-11), so test/d1 cannot show that this Worker runs without them.
// wrangler's bundler can: with no_nodejs_compat it refuses a bare `crypto`
// import and warns on `node:crypto` ("is built into node"). This script
// bundles worker/ (its wrangler.jsonc sets both flags) and fails on either,
// and on any `node:` import left in the bundle. The same check as
// examples/worker/proof/bundle-no-node.mjs.
//
// The config's alias points at the git-ignored input/import.local.json, which
// a clean tree does not hold. `--alias` points the bundle at the tracked
// sample input/import.json, which holds no user and no hash. wrangler 4.148.0
// splits the pair on ":" (collectKeyValues in wrangler-dist/cli.js, read
// 2026-10-11), as in --var LOCAL_IMPORT:1, and the flag wins over the config.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = mkdtempSync(join(tmpdir(), "tempo-auth-import-bundle-"));
try {
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      out,
      "--alias",
      "tempo-auth-import-input:./input/import.json",
    ],
    {
      encoding: "utf8",
      // Pin the directory: wrangler reads worker/wrangler.jsonc from here.
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    },
  );
  const log = `${run.stdout}\n${run.stderr}`;
  const failures = [];
  if (run.status !== 0) failures.push(`wrangler exited ${run.status}`);
  if (/is built into node/.test(log))
    failures.push("wrangler warned that a module is built into node");
  // Count what was scanned: a bundle in another file name or folder must not pass unseen.
  const files = readdirSync(out).filter((n) => /\.m?js$/.test(n));
  if (!files.includes("index.js"))
    failures.push("index.js is not in the output; scanned 0 entry files");
  for (const f of files) {
    const text = readFileSync(join(out, f), "utf8");
    // from "node:x", import "node:x", import("node:x"), require("node:x")
    if (/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']node:/.test(text))
      failures.push(`${f} imports a node: module`);
  }
  if (failures.length > 0) {
    console.error(log);
    console.error(`bundle-no-node: FAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(
    `bundle-no-node: PASS, ${files.length} bundle file(s) scanned, the import D1 Worker bundles with no_nodejs_compat and imports no node: module`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
