// Plan 12g: the SQLite migrations are the D1 files. This script copies each
// file of @authtempo/adapter-d1/migrations, in name order, into one module.
// test/migrations-copy.test.ts holds the copy to the files byte for byte.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../adapter-d1/migrations");
const target = resolve(here, "../src/migrations.generated.ts");

const files = readdirSync(source)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (files.length === 0) throw new Error(`copy-migrations: no .sql file in ${source}`);

const entries = files.map((f) => {
  const name = JSON.stringify(f.slice(0, -".sql".length));
  const sql = JSON.stringify(readFileSync(join(source, f), "utf8"));
  return `  { name: ${name}, sql: ${sql} },`;
});

const text = [
  "// Generated from @authtempo/adapter-d1/migrations by scripts/copy-migrations.mjs. Do not edit.",
  "export const D1_FILES = [",
  ...entries,
  "] as const;",
  "",
].join("\n");

// The typecheck runs this script after the build. A write of the same bytes
// makes src newer than dist, and the build-age rule of release-check (spec 33
// item 12.1) then fails on a fresh build (ruling 57 of plan 12j). So the
// script writes only when the bytes differ. A changed migration still writes,
// and the rule still fails until the next build.
const same = existsSync(target) && readFileSync(target, "utf8") === text;
if (!same) writeFileSync(target, text);
console.log(`copy-migrations: ${files.length} files, ${same ? "unchanged" : "written"}`);
