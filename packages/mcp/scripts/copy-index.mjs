// Copies the site's agent index next to the binary (plan 11e Task 5). The
// site build writes apps/site/dist/agent/index.json; the binary reads
// dist/agent/index.json by default. The copy is validated with the format's
// own parser, so the binary never loads a file that its parser refuses.
// It also refuses an index that is older than a page source. A copy of
// stale data with a PASS line proves nothing about the docs.
// Run it through `pnpm turbo run index --filter=@authtempo/mcp`, which builds
// this package and the site first. The flags --source, --content, and
// --target name other paths, for the tests.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const { values } = parseArgs({
  strict: true,
  options: {
    source: { type: "string", default: here("../../../apps/site/dist/agent/index.json") },
    content: { type: "string", default: here("../../../apps/site/src/content/docs/docs/") },
    target: { type: "string", default: here("../dist/agent/index.json") },
  },
});
const BUILD = "run pnpm turbo run build --filter=@authtempo/site";

function newestUnder(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) max = Math.max(max, statSync(join(e.parentPath, e.name)).mtimeMs);
  return max;
}

let text;
let mtime;
try {
  text = readFileSync(values.source, "utf8");
  mtime = statSync(values.source).mtimeMs;
} catch {
  console.error(`copy-index: FAIL ${values.source} is missing: ${BUILD}`);
  process.exit(1);
}
if (mtime < newestUnder(values.content)) {
  console.error(`copy-index: FAIL ${values.source} is older than a page source: ${BUILD}`);
  process.exit(1);
}
const { parseAgentIndex } = await import("../dist/index-format.js");
let index;
try {
  index = parseAgentIndex(text);
} catch (e) {
  console.error(`copy-index: FAIL ${e.message}`);
  process.exit(1);
}
mkdirSync(dirname(values.target), { recursive: true });
copyFileSync(values.source, values.target);
console.log(`copy-index: PASS pages=${index.pages.length}`);
