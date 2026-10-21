// The bundle proof of @authtempo/observe (plan 12h Task 10), in the form of
// examples/worker/proof/bundle-no-node.mjs. wrangler bundles proof/index.ts
// with no_nodejs_compat: it refuses a bare Node.js import and warns on a
// `node:` import ("is built into node"). The script fails on either, on a
// `node:` import left in the bundle, and on an entry of package.json that
// proof/index.ts does not import, so a new entry cannot pass unseen.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const failures = [];

// Each entry of package.json, for example ./workers-logs, is src/workers-logs.ts.
const entries = Object.keys(JSON.parse(readFileSync(here("../package.json"), "utf8")).exports);
const proof = readFileSync(here("index.ts"), "utf8");
for (const entry of entries)
  if (!proof.includes(`from "../src/${entry.slice(2)}.js"`))
    failures.push(`proof/index.ts does not import the entry ${entry}`);

const out = mkdtempSync(join(tmpdir(), "authtempo-observe-bundle-"));
try {
  const run = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out], {
    encoding: "utf8",
    // wrangler reads proof/wrangler.jsonc from this directory.
    cwd: here("."),
    // The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_HIDE_BANNER: "true",
      NO_COLOR: "1",
    },
  });
  const log = `${run.stdout}\n${run.stderr}`;
  if (run.status !== 0) failures.push(`wrangler exited ${run.status}`);
  if (/is built into node/.test(log))
    failures.push("wrangler warned that a module is built into node");
  // Count what was scanned: a bundle in another file name must not pass unseen.
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
    `bundle-no-node: PASS, ${entries.length} entries, ${files.length} bundle file(s) scanned, no node: module`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
