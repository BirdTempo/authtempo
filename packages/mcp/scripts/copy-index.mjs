// Copies the site's agent index next to the binary (plan 11e Task 5). The
// site build writes apps/site/dist/agent/index.json; the binary reads
// dist/agent/index.json by default. The copy is validated with the format's
// own parser, so the binary never loads a file that its parser refuses.
// Run it through `pnpm turbo run index --filter=@authtempo/mcp`, which builds
// this package and the site first.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../../../apps/site/dist/agent/index.json", import.meta.url));
const TARGET = fileURLToPath(new URL("../dist/agent/index.json", import.meta.url));

let text;
try {
  text = readFileSync(SOURCE, "utf8");
} catch {
  console.error(
    `copy-index: FAIL ${SOURCE} is missing: run pnpm turbo run build --filter=@authtempo/site`,
  );
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
mkdirSync(fileURLToPath(new URL("../dist/agent/", import.meta.url)), { recursive: true });
copyFileSync(SOURCE, TARGET);
console.log(`copy-index: PASS pages=${index.pages.length}`);
