// Plan 12g: the entry `./seam` must compile in a Node or Bun app, which has no
// Workers types. This script reads the built declaration of the entry and each
// local declaration it imports, and fails when one names a Workers type.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const ENTRY = join(DIST, "seam-entry.d.ts");
// Each global type of @cloudflare/workers-types that starts with D1 (D1Database,
// D1Result, D1Meta, ...), but not the seam's own D1Subset types or D1AdapterOptions.
const FORBIDDEN = [/\bD1(?!Subset|AdapterOptions)[A-Z]\w*/, /@cloudflare\/workers-types/];

if (!existsSync(ENTRY)) {
  console.error(`seam-dts: FAIL ${ENTRY} does not exist; run the build`);
  process.exit(1);
}

const seen = new Set();
const queue = [ENTRY];
const failures = [];
while (queue.length > 0) {
  const file = queue.pop();
  if (file === undefined || seen.has(file)) continue;
  seen.add(file);
  const text = readFileSync(file, "utf8");
  for (const re of FORBIDDEN) {
    const m = re.exec(text);
    if (m) failures.push(`${file} names ${m[0]}`);
  }
  // A local import or export of a declaration: "./x.js" is the file "./x.d.ts".
  for (const m of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)) {
    const next = join(dirname(file), `${m[1]}.d.ts`);
    if (!existsSync(next)) failures.push(`${file} imports ${m[1]}.js, which has no declaration`);
    else queue.push(next);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`seam-dts: FAIL ${f}`);
  process.exit(1);
}
console.log(`seam-dts: PASS files=${seen.size}`);
