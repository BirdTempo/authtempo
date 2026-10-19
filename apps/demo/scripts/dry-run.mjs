// The bundle check of the demo Worker (plan 11b Task 8). It never deploys.
// 1. `wrangler deploy --dry-run --outdir <tmp>` bundles src/worker.ts with the
//    settings of wrangler.jsonc (no_nodejs_compat).
// 2. The repo's bundle proof (examples/worker/proof/bundle-no-node.mjs) runs
//    on this folder: it fails on a node: import and on the "built into node"
//    warning. It bundles once more by itself, because it takes a Worker folder
//    and the entry name (worker.js, after main), not an output folder.
// It prints `demo-dry-run: PASS bytes=<n>` with the bytes of the bundle files.
// The bundle stays in dist/bundle/, and test/node/no-secret.test.ts scans it
// (plan 11b Task 12). The test script runs this file before vitest, so the
// scan reads a bundle of the same run.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const PROOF = fileURLToPath(
  new URL("../../../examples/worker/proof/bundle-no-node.mjs", import.meta.url),
);
// The four keys of each wrangler spawn (ruling 40 of plan 11e). The hidden
// banner skips wrangler's npm update check: its socket can hold the child.
const ENV = {
  ...process.env,
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
  WRANGLER_HIDE_BANNER: "true",
};

/** The bundle file: wrangler names it after main (src/worker.ts in wrangler.jsonc). */
const ENTRY = "worker.js";

// wrangler 4.148.0 refuses a dry run when assets.directory does not exist
// (seen 2026-10-20, ruling 31). The test script runs copy-assets.mjs first,
// which fills the folder; this line serves a run of this file alone.
mkdirSync(join(PKG, "dist", "public"), { recursive: true });

// A new folder each run, so no file of an older bundle reaches the scan.
const out = join(PKG, "dist", "bundle");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const failures = [];
let bytes = 0;
const run = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out], {
  encoding: "utf8",
  cwd: PKG,
  env: ENV,
});
if (run.status !== 0) {
  console.error(`${run.stdout}\n${run.stderr}`);
  failures.push(`wrangler exited ${run.status}`);
}
const files = run.status === 0 ? readdirSync(out).filter((n) => /\.m?js$/.test(n)) : [];
// Count what was bundled: an entry in another file name must not pass unseen.
if (run.status === 0 && !files.includes(ENTRY))
  failures.push(`${ENTRY} is not in the output; scanned 0 entry files`);
for (const f of files) bytes += statSync(join(out, f)).size;

if (failures.length === 0) {
  const proof = spawnSync(process.execPath, [PROOF, PKG, ENTRY], { encoding: "utf8", env: ENV });
  process.stdout.write(proof.stdout);
  process.stderr.write(proof.stderr);
  if (proof.status !== 0) failures.push(`the bundle proof exited ${proof.status}`);
}

if (failures.length > 0) {
  console.error(`demo-dry-run: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`demo-dry-run: PASS bytes=${bytes}`);
