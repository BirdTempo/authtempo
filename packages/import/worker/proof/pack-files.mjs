// The file list of a pack of @authtempo/import (plan 9b2). Publication is
// on hold; this check proves the `files` entry for the day it is not, with
// no publish. pnpm 12.8.1 prints the list with `pnpm pack --dry-run --json`
// (checked 2026-10-12).
//
// `files` in package.json is an allowlist of the shipped paths: `dist`, the
// Worker's README, config, and sources, and these proofs. It names no
// folder that can hold local state. pnpm does not apply `.gitignore` inside
// a folder that `files` names, so a `worker` entry shipped two git-ignored
// folders (I-1 of the plan 9b2 final review):
// - worker/.wrangler/: after a rehearsal, wrangler dev keeps the local D1
//   copy with every imported hash in `state/`, and the dev bundle with the
//   inlined input in `tmp/`.
// - worker/input/: import.local.json holds every password hash of an import.
//
// The check fails when any packed path is outside the allowlist below, when
// a path is under worker/input/ or matches a forbidden name of plan 12j (such
// as .wrangler/, src/ outside worker/src, or test/), or when a file that the
// Worker or the CLI needs is absent. It makes a fake
// worker/.wrangler/cache/cf.json and a fake worker/input/import.local.json
// when they do not exist, so a tree with no rehearsal shows the leak too,
// and it removes only what it made.
//
// LICENSE ships because an MIT package must carry its notice, and pnpm
// 12.8.1 copies the root LICENSE into the pack (its CHANGELOG, 12.0.0-rc.8,
// read 2026-10-20). CHANGELOG.md ships from the first release on (plan 12j).
// The shared forbidden names are the one list of plan 12j, which check-pack
// also reads. Node runs the .ts import by type stripping (Node 22.18 or later).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALWAYS_SHIPPED,
  CHANGELOG_FILE,
  forbiddenMatch,
} from "../../../../scripts/release/src/lib/pack-rules.ts";

const pkg = fileURLToPath(new URL("../..", import.meta.url));
const FAKES = [
  fileURLToPath(new URL("../.wrangler/cache/cf.json", import.meta.url)),
  fileURLToPath(new URL("../input/import.local.json", import.meta.url)),
];
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
/** The files a pack always holds (npm adds package.json and README.md). */
const FILES = [...ALWAYS_SHIPPED, CHANGELOG_FILE, "worker/README.md", "worker/wrangler.jsonc"];
/** The folders whose every file ships. None of them holds local state. */
const PREFIXES = ["dist/", "worker/src/", "worker/proof/"];
/**
 * The folder of this package that must never ship, beside the shared names.
 * The allowlist already refuses it; the name makes the failure clear.
 */
const INPUT = "worker/input/";
const NEEDED = [
  "package.json",
  "LICENSE",
  "dist/index.js",
  "worker/README.md",
  "worker/wrangler.jsonc",
  "worker/src/index.ts",
  "worker/src/run.ts",
  "worker/src/input.d.ts",
];

/** Each path this check made: a file, or the first folder it made on the way. */
const made = [];
const failures = [];
let paths = [];
try {
  // Inside the try: a throw on the second fake still removes the first.
  for (const fake of FAKES) {
    if (existsSync(fake)) continue;
    const dir = mkdirSync(dirname(fake), { recursive: true });
    // Recorded before the write, so a failed write still removes the folder.
    if (dir !== undefined) made.push(dir);
    writeFileSync(fake, "{}\n", { flag: "wx" });
    if (dir === undefined) made.push(fake);
  }
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
      const forbidden = p.startsWith(INPUT) ? INPUT : forbiddenMatch(p, manifest.files);
      if (forbidden) failures.push(`the pack holds ${p}, which matches ${forbidden}`);
      else if (!FILES.includes(p) && !PREFIXES.some((f) => p.startsWith(f)))
        failures.push(`the pack holds ${p}, outside the allowlist`);
    }
  }
} finally {
  for (const p of made) rmSync(p, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`pack-files: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  `pack-files: PASS, ${paths.length} packed file(s) checked, each inside the allowlist, no local state`,
);
