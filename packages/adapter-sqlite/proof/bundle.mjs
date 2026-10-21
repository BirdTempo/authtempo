// The two bundle proofs of the SQLite adapter (plan 12g Task 4). It never deploys.
// 1. `wrangler deploy --dry-run --outdir <tmp>` bundles proof/worker/index.ts
//    (the libSQL entry, @libsql/client/web, and the adapter) with Node.js
//    compatibility off. The proof fails on the "built into node" warning and
//    on any import or require of a Node built-in left in the bundle.
//    The bundle must hold a marker of dist/libsql.js and one of
//    @libsql/client/web: a Worker that imports nothing must not pass.
// 2. No built entry of the package imports a driver at run time (deviation 5).
//    The proof reads each file of dist/ for an import of better-sqlite3,
//    bun:sqlite, node:sqlite, or @libsql/client. The app opens the database.
// It prints `bundle-no-node: PASS bytes=<n>` and `entries-no-driver: PASS entries=<n>`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
// The wrangler rule of the repo (ruling 40 of plan 11e): the hidden banner
// skips the npm update check, whose socket can hold the child.
const ENV = {
  ...process.env,
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
  WRANGLER_HIDE_BANNER: "true",
};

/** The bundle file: wrangler names it after main (index.ts in proof/worker/wrangler.jsonc). */
const ENTRY = "index.js";

/** The module text of each import, export-from, dynamic import, and require of a file. */
function specifiers(text) {
  const found = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
  for (const m of text.matchAll(re)) if (m[1] !== undefined) found.push(m[1]);
  return found;
}

const NODE_BUILTINS = new Set(builtinModules);
const isNodeBuiltin = (s) => s.startsWith("node:") || NODE_BUILTINS.has(s.split("/")[0] ?? s);

/** The drivers that no entry may import at run time (deviation 5 of plan 12g). */
const DRIVERS = ["better-sqlite3", "bun:sqlite", "node:sqlite", "@libsql/client"];
const isDriver = (s) => DRIVERS.some((d) => s === d || s.startsWith(`${d}/`));

/**
 * The texts that only these modules hold. The proof reads each marker in its
 * source file first, so a marker that a change removes fails here, not silently.
 */
const MARKERS = [
  {
    file: join(PKG, "dist", "libsql.js"),
    texts: ['name: "libsql"', "batch takes statements of this database"],
  },
  {
    file: fileURLToPath(import.meta.resolve("@libsql/client/web")),
    texts: ["The client that uses Web standard APIs supports only"],
  },
];

const failures = [];

// 1. The Worker bundle.
const out = mkdtempSync(join(tmpdir(), "authtempo-sqlite-bundle-"));
let bytes = 0;
try {
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      out,
      "--config",
      "proof/worker/wrangler.jsonc",
    ],
    { encoding: "utf8", cwd: PKG, env: ENV },
  );
  const log = `${run.stdout}\n${run.stderr}`;
  if (run.status !== 0) {
    console.error(log);
    failures.push(`wrangler exited ${run.status}`);
  }
  if (/is built into node/.test(log))
    failures.push("wrangler warned that a module is built into node");
  const files = run.status === 0 ? readdirSync(out).filter((n) => /\.m?js$/.test(n)) : [];
  // Count what was scanned: a bundle in another file name must not pass unseen.
  if (run.status === 0 && !files.includes(ENTRY))
    failures.push(`${ENTRY} is not in the output; scanned 0 entry files`);
  let bundle = "";
  for (const f of files) {
    const text = readFileSync(join(out, f), "utf8");
    bundle += text;
    bytes += statSync(join(out, f)).size;
    for (const s of specifiers(text))
      if (isNodeBuiltin(s)) failures.push(`${f} imports the Node module ${s}`);
  }
  if (run.status === 0)
    for (const { file, texts } of MARKERS) {
      const source = existsSync(file) ? readFileSync(file, "utf8") : "";
      for (const t of texts) {
        if (!source.includes(t)) failures.push(`the marker ${JSON.stringify(t)} is not in ${file}`);
        else if (!bundle.includes(t))
          failures.push(`the bundle lacks ${JSON.stringify(t)} of ${file}`);
      }
    }
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`bundle-no-node: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`bundle-no-node: PASS bytes=${bytes}`);

// 2. The built entries.
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const entries = Object.values(pkg.exports).map((e) => e.default);
for (const e of entries)
  if (!existsSync(join(PKG, e))) failures.push(`the entry ${e} is not built: run the build`);
const dist = join(PKG, "dist");
const built = existsSync(dist) ? readdirSync(dist).filter((n) => n.endsWith(".js")) : [];
if (built.length < entries.length)
  failures.push(`dist holds ${built.length} files, fewer than the entries`);
for (const f of built)
  for (const s of specifiers(readFileSync(join(dist, f), "utf8")))
    if (isDriver(s)) failures.push(`dist/${f} imports the driver ${s} at run time`);
if (failures.length > 0) {
  console.error(`entries-no-driver: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`entries-no-driver: PASS entries=${entries.length} files=${built.length}`);
