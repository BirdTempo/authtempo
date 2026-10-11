// Plan 10 (consumerf adoption): packs the four packages that a consumer vendors,
// checks each tarball against the workspace, and prints its SHA-256 in the
// `shasum -a 256` format. The consumer saves the output as vendor/SHA256SUMS,
// so `shasum -a 256 -c SHA256SUMS` proves the vendored files are these.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The package directories. The names and versions come from each package.json.
const DIRS = ["core", "adapter-postgres", "client", "handoff"];

if (process.argv.length !== 3) {
  console.error("usage: node scripts/pack-for-consumers.mjs <empty out dir>");
  process.exit(2);
}
const out = resolve(process.argv[2]);
// An empty directory only: a stale tarball beside the new ones would pass the name check.
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`${out} is not empty`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const root = resolve(import.meta.dirname, "..");
const expected = DIRS.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  // pnpm pack names @scope/name at version v as scope-name-v.tgz.
  return { name: pkg.name, file: `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz` };
});

// A dist older than the source packs old code. --force skips the Turborepo cache.
execFileSync(
  "pnpm",
  ["turbo", "run", "build", ...expected.map((p) => `--filter=${p.name}`), "--force"],
  { cwd: root, stdio: "inherit" },
);
for (const p of expected) {
  execFileSync("pnpm", ["--filter", p.name, "pack", "--pack-destination", out], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

const found = readdirSync(out).sort();
const want = expected.map((p) => p.file).sort();
let failed = false;
if (JSON.stringify(found) !== JSON.stringify(want)) {
  console.error(`pack: found ${found.join(", ")}; expected ${want.join(", ")}`);
  failed = true;
}
for (const p of expected) {
  if (!found.includes(p.file)) continue;
  const path = join(out, p.file);
  const manifest = execFileSync("tar", ["-xzOf", path, "package/package.json"], {
    encoding: "utf8",
  });
  // pnpm pack turns workspace:* into the version. A range that stays cannot install.
  if (manifest.includes("workspace:")) {
    console.error(`${p.file}: package.json still holds a workspace: range`);
    failed = true;
  }
  const files = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).split("\n");
  if (!files.includes("package/dist/index.js")) {
    console.error(`${p.file}: no package/dist/index.js; the build did not run`);
    failed = true;
  }
}
if (failed) process.exit(1);
for (const p of expected) {
  const hex = createHash("sha256")
    .update(readFileSync(join(out, p.file)))
    .digest("hex");
  console.log(`${hex}  ${p.file}`);
}
