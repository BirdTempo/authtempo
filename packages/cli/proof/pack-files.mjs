// The file list of a pack of @authtempo/cli (plan 11c). Publication is on
// hold; this check proves the `files` entry with no publish, as the import
// package's proof does. pnpm 12.8.1 prints the list with
// `pnpm pack --dry-run --json` (checked 2026-10-12 for packages/import).
//
// The pack holds package.json, README.md, LICENSE, and dist/ only. It must
// never hold a test, a source file, a scaffold of the tests, or local state: a
// .env, a .dev.vars, a .wrangler folder, or a node_modules folder.
//
// LICENSE ships because an MIT package must carry its notice, and pnpm
// 12.8.1 copies the root LICENSE into the pack (its CHANGELOG, 12.0.0-rc.8,
// read 2026-10-20).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
/** The files a pack always holds. */
const FILES = ["package.json", "README.md", "LICENSE"];
/** The folders whose every file ships. */
const PREFIXES = ["dist/"];
/** Names that never ship, at the start of a path or after any slash. */
const FORBIDDEN = [
  ".env",
  ".dev.vars",
  ".wrangler/",
  "node_modules/",
  ".scaffold/",
  "test/",
  "src/",
];
const NEEDED = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/main.js",
  "dist/bin/authtempo.js",
  "dist/bin/authtempo-import.js",
  "dist/templates.json",
  // Each target of the exports map, so a build that drops an entry file fails
  // here (ruling 21 of the plan 11b lane). The map is the one source.
  ...exportTargets(),
];

/** Each path that the exports map of package.json names, with no leading "./". */
function exportTargets() {
  const { exports } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const targets = Object.values(exports).flatMap((entry) =>
    typeof entry === "string" ? [entry] : Object.values(entry),
  );
  if (targets.length === 0) throw new Error("pack-files: the exports map names no file");
  return [...new Set(targets.map((t) => t.replace(/^\.\//, "")))];
}

const failures = [];
let paths = [];
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
  for (const need of NEEDED) if (!paths.includes(need)) failures.push(`${need} is not in the pack`);
  for (const p of paths) {
    const forbidden = FORBIDDEN.find((f) => p.startsWith(f) || p.includes(`/${f}`));
    if (forbidden) failures.push(`the pack holds ${p}, which matches ${forbidden}`);
    else if (!FILES.includes(p) && !PREFIXES.some((f) => p.startsWith(f)))
      failures.push(`the pack holds ${p}, outside the allowlist`);
  }
}
if (failures.length > 0) {
  console.error(`pack-files: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  `pack-files: PASS, ${paths.length} packed file(s) checked, each inside the allowlist, no local state, ${NEEDED.length} needed file(s) present`,
);
