// The file list of a pack of @authtempo/verify (plan 11d).
// Publication is on hold. This check proves the `files` entry with no publish.
// pnpm 12.8.1 prints the list with `pnpm pack --dry-run --json`.
// The answer is one object with a `files` list of `{ path }`.
// This is the same read as packages/import/worker/proof/pack-files.mjs, checked 2026-10-12.
// The package's test script runs `tsc` first, so `dist` is newer than the
// source that this check reads it for.
// LICENSE ships because an MIT package must carry its notice, and pnpm
// 12.8.1 copies the root LICENSE into the pack (its CHANGELOG, 12.0.0-rc.8,
// read 2026-10-20). CHANGELOG.md ships from the first release on (plan 12j).
// The forbidden names are the one list of plan 12j, which check-pack also
// reads. Node runs the .ts import by type stripping (Node 22.18 or later).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALWAYS_SHIPPED,
  CHANGELOG_FILE,
  forbiddenMatch,
} from "../../../scripts/release/src/lib/pack-rules.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
/** The files a pack always holds, outside dist/. */
const FILES = [...ALWAYS_SHIPPED, CHANGELOG_FILE];
/** The files a pack must hold. npm adds package.json and README.md. */
const NEEDED = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  // The ./mcp entry of plan 11e: without these two files the entry does not resolve.
  "dist/mcp.js",
  "dist/mcp.d.ts",
];
const run = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: pkg,
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1" },
});
const failures = [];
let paths = [];
if (run.status !== 0) {
  console.error(`${run.stdout}\n${run.stderr}`);
  failures.push(`pnpm pack exited ${run.status}`);
} else {
  paths = JSON.parse(run.stdout).files.map((f) => f.path);
  for (const p of paths) {
    const forbidden = forbiddenMatch(p, manifest.files);
    if (forbidden) failures.push(`the pack holds ${p}, which matches ${forbidden}`);
    else if (!(FILES.includes(p) || p.startsWith("dist/")))
      failures.push(`the pack holds ${p}, outside the allowlist`);
  }
  for (const p of NEEDED) if (!paths.includes(p)) failures.push(`${p} is not in the pack`);
}
if (failures.length > 0) {
  console.error(`pack-files: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`pack-files: PASS, ${paths.length} packed file(s) checked, each inside the allowlist`);
