// Plan 11b Task 3. Each script that builds runs this right after build-agent.
// Astro copies public/_headers.template to dist/ as it is. This writes
// dist/_headers with the hash of each inline script of dist in the CSP. It
// also writes the style counts of dist in the style-src comment. Then it
// deletes the copied template, so the Worker serves no template file. The
// hashes change when Starlight or the theme toggle changes a script, so the
// build computes them; no file holds a literal hash. check-csp reads the
// build again and holds the written file to it.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fillHeaders } from "./lib/headers.ts";
import { distPages } from "./lib/load.ts";
import { DIST } from "./lib/paths.ts";

const TEMPLATE = `${DIST}_headers.template`;

if (!existsSync(TEMPLATE)) {
  console.error("write-headers: FAIL dist/_headers.template is missing; run astro build first");
  process.exit(1);
}
try {
  const pages = distPages();
  const headers = fillHeaders(readFileSync(TEMPLATE, "utf8"), pages);
  writeFileSync(`${DIST}_headers`, headers);
  rmSync(TEMPLATE);
  const hashes = headers.split("'sha256-").length - 1;
  console.log(`write-headers: PASS pages=${pages.size} hashes=${hashes}`);
} catch (e) {
  console.error(`write-headers: FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
