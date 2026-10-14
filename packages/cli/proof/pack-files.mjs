// The file list of a pack of @authtempo/cli (plan 11c). Publication is on
// hold; this check proves the `files` entry with no publish, as the import
// package's proof does. pnpm 12.8.1 prints the list with
// `pnpm pack --dry-run --json` (checked 2026-10-12 for packages/import).
//
// The pack holds package.json, README.md, and dist/ only. It must never hold
// a test, a source file, a scaffold of the tests, or local state: a .env, a
// .dev.vars, a .wrangler folder, or a node_modules folder.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
/** The files a pack always holds. */
const FILES = ["package.json", "README.md"];
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
  "dist/index.js",
  "dist/main.js",
  "dist/bin/authtempo.js",
  "dist/bin/authtempo-import.js",
  "dist/templates.json",
];

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
  `pack-files: PASS, ${paths.length} packed file(s) checked, each inside the allowlist, no local state`,
);
