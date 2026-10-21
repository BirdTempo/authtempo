// Plan 12g: the SQLite migrations are the D1 files. This script copies each
// file of @authtempo/adapter-d1/migrations, in name order, into one module.
// test/migrations-copy.test.ts holds the copy to the files byte for byte.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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

writeFileSync(
  target,
  [
    "// Generated from @authtempo/adapter-d1/migrations by scripts/copy-migrations.mjs. Do not edit.",
    "export const D1_FILES = [",
    ...entries,
    "] as const;",
    "",
  ].join("\n"),
);
console.log(`copy-migrations: ${files.length} files`);
