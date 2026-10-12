// The bundle check of the import D1 Worker with Node.js compatibility off
// (plan 9b, final review M-3; plan 9b2).
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
// Plan 9b2: the Worker imports `@tempo-auth/import`, the package's public
// entry, which esbuild resolves by the package's own name to ../dist. So the
// bundle is what a published package would build. This script fails when the
// bundle reads any file of ../src (the metafile of `--metafile`, whose input
// keys are relative to worker/, read 2026-10-12), when it reads no file of
// ../dist, and when ../dist is older than a file of ../src: a pass proves
// nothing until the build is newer than the change. Turbo builds the package
// before its test (packages/import/turbo.json).
//
// The config's alias points at the git-ignored input/import.local.json, which
// a clean tree does not hold. `--alias` points the bundle at the tracked
// sample input/import.json, which holds no user and no hash. wrangler 4.148.0
// splits the pair on ":" (collectKeyValues in wrangler-dist/cli.js, read
// 2026-10-11), as in --var LOCAL_IMPORT:1, and the flag wins over the config.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = resolve(workerDir, "..");
const failures = [];

/** The newest modification time of the files under `dir`. */
function newest(dir) {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    max = Math.max(max, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return max;
}

// The build must be newer than the change. The compare of modification times
// holds because the package's `tsc -p tsconfig.json` runs with no
// `incremental` setting (tsconfig.json and tsconfig.base.json, checked
// 2026-10-12): each build writes every file of dist again, so dist/index.js
// gets a new time on each build. With `incremental` on, tsc can skip an
// unchanged file, and an old dist/index.js would read as stale.
const distIndex = join(pkgDir, "dist", "index.js");
let distTime = 0;
try {
  distTime = statSync(distIndex).mtimeMs;
} catch {
  failures.push("dist/index.js is missing; run pnpm turbo run build --filter=@tempo-auth/import");
}
if (distTime > 0 && distTime < newest(join(pkgDir, "src")))
  failures.push(
    "dist is older than src; run pnpm turbo run build --filter=@tempo-auth/import, then this check",
  );

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
      "--metafile",
      join(out, "meta.json"),
      "--alias",
      "tempo-auth-import-input:./input/import.json",
    ],
    {
      encoding: "utf8",
      // Pin the directory: wrangler reads worker/wrangler.jsonc from here.
      cwd: workerDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    },
  );
  const log = `${run.stdout}\n${run.stderr}`;
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
  let inputs = [];
  try {
    inputs = Object.keys(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")).inputs).map((k) =>
      resolve(workerDir, k),
    );
  } catch {
    failures.push("wrangler wrote no metafile; scanned 0 inputs");
  }
  const fromSrc = inputs.filter((p) => p.startsWith(`${join(pkgDir, "src")}/`));
  const fromDist = inputs.filter((p) => p.startsWith(`${join(pkgDir, "dist")}/`));
  for (const p of fromSrc) failures.push(`the bundle reads ${p}, not the package entry`);
  if (fromDist.length === 0)
    failures.push("the bundle reads no file of dist; scanned 0 dist inputs");
  if (failures.length > 0) {
    console.error(log);
    console.error(`bundle-no-node: FAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(
    `bundle-no-node: PASS, ${files.length} bundle file(s) and ${fromDist.length} dist input(s) scanned, the import D1 Worker bundles from the package entry with no_nodejs_compat and imports no node: module`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
