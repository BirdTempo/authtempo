// The bundle check of the remote Worker (plan 11e Task 16). It never deploys.
// 1. `wrangler deploy --dry-run --outdir <tmp>` bundles src/worker.ts with the
//    settings of wrangler.jsonc (no_nodejs_compat), and prints its size lines.
// 2. The repo's bundle proof (examples/worker/proof/bundle-no-node.mjs) runs
//    on this folder: it fails on a node: import and on the "built into node"
//    warning. It bundles once more by itself, because it takes a Worker folder
//    and the entry name (worker.js, after main).
// 3. The bundle holds no module of @authtempo/cli and no node:child_process.
// 4. The bundle holds no stdio module of the SDK. esbuild drops serveStdio of
//    protocol.ts, because the Worker never calls it, and with it the dynamic
//    import (review I-5 of Task 5). A Worker that reached it would serve no stdio.
// It prints `mcp-dry-run: PASS bytes=<n>` with the bytes of the bundle files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const PROOF = fileURLToPath(
  new URL("../../../examples/worker/proof/bundle-no-node.mjs", import.meta.url),
);
// The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
const ENV = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  NO_COLOR: "1",
};

/** The bundle file: wrangler names it after main (src/worker.ts in wrangler.jsonc). */
const ENTRY = "worker.js";

/** The path comment of a bundled module of packages/cli (the workspace link or the store). */
const CLI_MODULE = /^\/\/ \S*\bcli\/dist\//m;

/** The stdio module of the SDK (2.3.1): the Worker serves HTTP only. */
const STDIO_MODULE = "@modelcontextprotocol/server/dist/stdio.mjs";

const out = mkdtempSync(join(tmpdir(), "authtempo-mcp-dry-run-"));
const failures = [];
let bytes = 0;
try {
  const run = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out], {
    encoding: "utf8",
    cwd: PKG,
    env: ENV,
  });
  const log = `${run.stdout}\n${run.stderr}`;
  // The size lines and the exit line of wrangler, for the record.
  for (const line of log.split("\n"))
    if (/Total Upload|dry-run|Your Worker has access|env\.|exiting/i.test(line))
      console.log(`wrangler: ${line.trim()}`);
  if (run.status !== 0) {
    console.error(log);
    failures.push(`wrangler exited ${run.status}`);
  }

  const files = run.status === 0 ? readdirSync(out).filter((n) => /\.m?js$/.test(n)) : [];
  if (run.status === 0 && !files.includes(ENTRY))
    failures.push(`${ENTRY} is not in the output; scanned 0 entry files`);
  for (const f of files) {
    const text = readFileSync(join(out, f), "utf8");
    bytes += statSync(join(out, f)).size;
    // esbuild names a workspace module by its path ("// ../cli/dist/args.js"), not by its package.
    if (text.includes("@authtempo/cli") || CLI_MODULE.test(text))
      failures.push(`${f} holds @authtempo/cli`);
    if (text.includes("node:child_process")) failures.push(`${f} holds node:child_process`);
    // esbuild writes the path of each bundled module as a comment line.
    if (text.includes(STDIO_MODULE)) failures.push(`${f} holds the stdio module of the SDK`);
  }

  if (failures.length === 0) {
    const proof = spawnSync(process.execPath, [PROOF, PKG, ENTRY], { encoding: "utf8", env: ENV });
    process.stdout.write(proof.stdout);
    process.stderr.write(proof.stderr);
    if (proof.status !== 0) failures.push(`the bundle proof exited ${proof.status}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`mcp-dry-run: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`mcp-dry-run: PASS bytes=${bytes}`);
