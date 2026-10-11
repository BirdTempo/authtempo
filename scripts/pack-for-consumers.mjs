// Plan 10 (consumerf adoption): packs the four packages that a consumer vendors,
// checks each tarball against the workspace, and prints its SHA-256 in the
// `shasum -a 256` format. The consumer saves the output as vendor/SHA256SUMS,
// so `shasum -a 256 -c SHA256SUMS` proves the vendored files are these.
// Only the hash lines go to stdout. All other output goes to stderr.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// The package directories. The names and versions come from each package.json.
const DIRS = ["core", "adapter-postgres", "client", "handoff"];

// Child output goes to stderr (fd 2). Turbo and pnpm print to stdout. If that output
// reached our stdout, `> SHA256SUMS` would hold non-hash lines and `shasum -c` would fail.
const CHILD_STDIO = ["ignore", 2, 2];

if (process.argv.length !== 3) {
  console.error("usage: node scripts/pack-for-consumers.mjs <empty out dir>");
  process.exit(2);
}
const out = resolve(process.argv[2]);
if (existsSync(out) && !statSync(out).isDirectory()) {
  console.error(`${out} is not a directory`);
  process.exit(2);
}
// An empty directory only: a stale tarball beside the new ones would pass the name check.
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`${out} is not empty`);
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
// Runs git in the repo. A failure prints one line and exits 1, with no stack trace.
function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const line = String(error.stderr ?? "").split("\n")[0] || "not a git checkout";
    console.error(`git ${args[0]} failed: ${line}`);
    process.exit(1);
  }
}

// The consumer records the HEAD commit beside the hashes as the source of the tarballs.
// A changed file under these paths would ship in a tarball, but HEAD would not hold it.
// So refuse a dirty tree. Then the same commit always gives the same hashes.
// tsconfig.base.json is in the list because every packed package extends it. It sets
// the emit options, so an uncommitted edit changes dist and the hashes.
const dirty = git(
  "status",
  "--porcelain",
  "--",
  "packages",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "tsconfig.base.json",
)
  .split("\n")
  .filter(Boolean);
if (dirty.length > 0) {
  console.error(`the tree is not clean: ${dirty[0].slice(3)} has an uncommitted change`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const expected = DIRS.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  // pnpm pack names @scope/name at version v as scope-name-v.tgz.
  // Every workspace package has a scope, so slice(1) removes the "@".
  return {
    dir,
    name: pkg.name,
    file: `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz`,
    needed: exportTargets(pkg.exports),
  };
});

// The files that an `exports` map points at: each string value, and the `import`
// and `default` keys of each object value, at any depth.
function exportTargets(node) {
  if (typeof node === "string") return [node];
  if (node === null || typeof node !== "object") return [];
  // A map of subpaths (keys start with ".") keeps every value. A map of conditions keeps two.
  const subpaths = Object.keys(node).some((key) => key.startsWith("."));
  return Object.entries(node)
    .filter(([key]) => subpaths || key === "import" || key === "default")
    .flatMap(([, value]) => exportTargets(value));
}

// tsc does not delete the output of a removed source file. A stale file in dist would
// ship in the tarball. Remove dist first. --force skips the Turborepo cache.
for (const p of expected)
  rmSync(join(root, "packages", p.dir, "dist"), { recursive: true, force: true });
try {
  execFileSync(
    "pnpm",
    ["turbo", "run", "build", ...expected.map((p) => `--filter=${p.name}`), "--force"],
    { cwd: root, stdio: CHILD_STDIO },
  );
} catch {
  console.error("build failed; see the output above");
  process.exit(1);
}
for (const p of expected) {
  try {
    execFileSync("pnpm", ["--filter", p.name, "pack", "--pack-destination", out], {
      cwd: root,
      stdio: CHILD_STDIO,
    });
  } catch {
    console.error(`pack failed for ${p.name}; see the output above`);
    process.exit(1);
  }
}

const found = readdirSync(out).sort();
const want = expected.map((p) => p.file).sort();
let failed = false;
if (JSON.stringify(found) !== JSON.stringify(want)) {
  console.error(`pack: found ${found.join(", ")}; expected ${want.join(", ")}`);
  failed = true;
}
const PROTOCOLS = ["workspace:", "catalog:", "link:"];
for (const p of expected) {
  if (!found.includes(p.file)) continue;
  const path = join(out, p.file);
  let manifest;
  let files;
  try {
    manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" }),
    );
    files = new Set(execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).split("\n"));
  } catch {
    console.error(`${p.name}: cannot read ${p.file}`);
    process.exit(1);
  }
  // pnpm pack turns workspace:* into the version. A range that stays cannot install.
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (PROTOCOLS.some((protocol) => String(range).startsWith(protocol))) {
        console.error(`${p.file}: ${field}.${dep} still holds the range ${range}`);
        failed = true;
      }
    }
  }
  for (const target of p.needed) {
    const inTarball = `package/${target.replace(/^\.\//, "")}`;
    if (!files.has(inTarball)) {
      console.error(`${p.file}: no ${inTarball}; the build did not run`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
const head = git("rev-parse", "HEAD").trim();
console.error(`HEAD ${head}`);
for (const p of expected) {
  const hex = createHash("sha256")
    .update(readFileSync(join(out, p.file)))
    .digest("hex");
  console.log(`${hex}  ${p.file}`);
}
