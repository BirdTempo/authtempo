// The no-Node check of an SDK's source (plan 11d). An SDK runs in a browser,
// on Workers, and in Expo, where a Node module does not exist. The check reads
// every .ts and .tsx file under the folder it is given, from the package's own
// folder, and fails on an import of a `node:` module or of a bare Node builtin.
// It fails when it reads no file: a check that reads nothing is not a pass.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUILTINS = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];
const dir = process.argv[2];
if (!dir) {
  console.error("no-node: FAIL usage: node scripts/check-no-node.mjs <dir>");
  process.exit(2);
}
const root = resolve(dir);
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name)) files.push(p);
  }
};
walk(root);
const spec = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
const failures = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(spec)) {
    const name = m[1] ?? "";
    if (name.startsWith("node:") || BUILTINS.includes(name.split("/")[0] ?? ""))
      failures.push(`${f}: imports ${name}`);
  }
}
if (files.length === 0) failures.push(`read 0 files under ${dir}`);
for (const f of failures) console.error(`no-node: ${f}`);
console.log(
  `no-node: ${failures.length === 0 ? "PASS" : "FAIL"} files=${files.length} dir=${dir} failures=${failures.length}`,
);
if (failures.length > 0) process.exit(1);
