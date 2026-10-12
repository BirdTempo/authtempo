// The file list of a pack of @tempo-auth/import (plan 9b2). Publication is
// on hold; this check proves the `files` entry for the day it is not, with
// no publish. pnpm 12.8.1 prints the list with `pnpm pack --dry-run --json`
// and honors a `!` entry in `files` (checked 2026-10-12).
//
// It fails when the pack lacks a file that the Worker or the CLI needs, holds
// a source or test file, or holds worker/input/import.local.json. That file
// is git-ignored and holds every password hash of an import, and before plan
// 9b2 a pack from a tree that had it shipped it. So the check makes the file
// when none exists, and removes only a file it made.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("../..", import.meta.url));
const local = fileURLToPath(new URL("../input/import.local.json", import.meta.url));
const NEEDED = [
  "package.json",
  "dist/index.js",
  "dist/cli.js",
  "worker/README.md",
  "worker/wrangler.jsonc",
  "worker/src/index.ts",
  "worker/src/run.ts",
  "worker/src/input.d.ts",
  "worker/input/import.json",
];

const made = !existsSync(local);
if (made) writeFileSync(local, "{}\n", { flag: "wx" });
const failures = [];
let paths = [];
try {
  const run = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: pkg,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (run.status !== 0) {
    console.error(`${run.stdout}\n${run.stderr}`);
    failures.push(`pnpm pack exited ${run.status}`);
  } else {
    paths = JSON.parse(run.stdout).files.map((f) => f.path);
    for (const need of NEEDED)
      if (!paths.includes(need)) failures.push(`${need} is not in the pack`);
    for (const p of paths) {
      if (p === "worker/input/import.local.json")
        failures.push("the pack holds worker/input/import.local.json, the input with the hashes");
      if (/^(src|test)\//.test(p)) failures.push(`the pack holds ${p}`);
    }
  }
} finally {
  if (made) rmSync(local, { force: true });
}
if (failures.length > 0) {
  console.error(`pack-files: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  `pack-files: PASS, ${paths.length} packed file(s) checked, no input file and no source file`,
);
