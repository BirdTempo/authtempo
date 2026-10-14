// The file list of a pack of @authtempo/verify (plan 11d).
// Publication is on hold; this check proves the `files` entry with no
// publish. pnpm 12.8.1 prints the list with `pnpm pack --dry-run --json`, and
// the answer is one object with a `files` list of `{ path }` (the same read
// as packages/import/worker/proof/pack-files.mjs, checked 2026-10-12).
// The package's test script runs `tsc` first, so `dist` is newer than the
// source that this check reads it for.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
/** The files a pack must hold. npm adds package.json and README.md. */
const NEEDED = ["package.json", "README.md", "dist/index.js", "dist/index.d.ts"];
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
  for (const p of paths)
    if (!(p === "package.json" || p === "README.md" || p.startsWith("dist/")))
      failures.push(`the pack holds ${p}, outside the allowlist`);
  for (const p of NEEDED) if (!paths.includes(p)) failures.push(`${p} is not in the pack`);
}
if (failures.length > 0) {
  console.error(`pack-files: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`pack-files: PASS, ${paths.length} packed file(s) checked, each inside the allowlist`);
