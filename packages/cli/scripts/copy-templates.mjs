// The build step of the init templates (plan 11c, spec 19): it renders
// each stack from its 11a example app with the declared rewrites of
// src/templates.ts, and writes dist/templates.json. It runs after tsc and
// imports dist. A Turbo cache does not see a change of an example, so the
// drift test of test/init.test.ts renders again and compares.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderAll } from "../dist/templates.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const { version } = JSON.parse(readFileSync(`${pkg}package.json`, "utf8"));
const all = renderAll(repo, version);
writeFileSync(`${pkg}dist/templates.json`, `${JSON.stringify(all)}\n`);
const counts = Object.entries(all)
  .map(([stack, files]) => `${stack} ${files.length}`)
  .join(", ");
console.log(`copy-templates: wrote dist/templates.json (${counts} files)`);
