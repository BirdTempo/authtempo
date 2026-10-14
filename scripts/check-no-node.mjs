// The no-Node check of an SDK's source (plan 11d). An SDK runs in a browser,
// on Workers, and in Expo, where no Node module exists.
// The check reads every .ts and .tsx file under the folder that it gets.
// It fails on an import of a Node builtin, with or without the `node:` prefix.
// It also fails on an `import(` or a `require(` whose argument is not a string literal.
// A template literal or a variable can name any module, so the check cannot read it.
// It fails when it reads no file: a check that reads nothing is not a pass.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";

// The list of the running Node, so a new builtin (such as async_hooks) needs no edit here.
// Some entries carry the prefix only (node:test); the prefix rule below covers them.
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
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
const literal = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
// An import( or require( call whose first argument does not start with a quote.
const dynamic = /(?:^|[^.\w$])(import|require)\s*\(\s*(?!["'])(\S)/gm;
const failures = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(literal)) {
    const name = m[1] ?? "";
    if (name.startsWith("node:") || BUILTINS.has(name) || BUILTINS.has(name.split("/")[0] ?? ""))
      failures.push(`${f}: imports ${name}`);
  }
  for (const m of text.matchAll(dynamic)) {
    // `import()` with no argument is a syntax error, and `)` here means none.
    if (m[2] === ")") continue;
    const line = text.slice(0, m.index).split("\n").length;
    failures.push(`${f}:${line}: ${m[1]}( with an argument that is not a string literal`);
  }
}
if (files.length === 0) failures.push(`read 0 files under ${dir}`);
for (const f of failures) console.error(`no-node: ${f}`);
console.log(
  `no-node: ${failures.length === 0 ? "PASS" : "FAIL"} files=${files.length} dir=${dir} failures=${failures.length}`,
);
if (failures.length > 0) process.exit(1);
