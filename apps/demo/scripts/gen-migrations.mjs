// Writes src/migrations.gen.ts from the shipped migrations of @authtempo/adapter-d1
// (plan 11b Task 8). The sandbox applies these files as they are: no schema of its own.
// The files go in name order, which is the order of their schema versions.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../../packages/adapter-d1/migrations/", import.meta.url));
const OUT = fileURLToPath(new URL("../src/migrations.gen.ts", import.meta.url));

const names = readdirSync(DIR)
  .filter((n) => n.endsWith(".sql"))
  .sort();
// Count what was read: an empty folder must not give a sandbox with no tables.
if (names.length === 0) {
  console.error(`gen-migrations: FAIL: no .sql file in ${DIR}`);
  process.exit(1);
}
const rows = names.map((name) => ({ name, sql: readFileSync(`${DIR}${name}`, "utf8") }));
const text = `// Written by scripts/gen-migrations.mjs from the shipped migrations of @authtempo/adapter-d1. Do not edit.
export const MIGRATIONS = ${JSON.stringify(rows, null, 2)} as const;
`;
writeFileSync(OUT, text);
console.log(`gen-migrations: PASS files=${names.length}`);
