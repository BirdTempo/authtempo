// The agent files of the site build (plan 11e). `astro build` writes dist;
// this step then writes dist/agent/index.json from the page sources, in the
// sidebar order of the built home page. It validates the index with the
// format's own parser before the write, so the server never loads a file
// that its parser refuses. It runs before the checks, which read its output.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAgentIndex } from "@authtempo/mcp/index-format";
import { FORBIDDEN_TERMS } from "./check-terms.ts";
import { bindingsOf, buildAgentIndex, sidebarGroups, sidebarOrder, termsOf } from "./lib/agent.ts";
import { EXPORT_ENTRIES, SDK_PACKAGES } from "./lib/entries.ts";
import { docsPages } from "./lib/load.ts";
import { DIST, DOCS, REPO } from "./lib/paths.ts";

/** The commit of the tree, or "unknown" when the tree has no git. */
function commitOf(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const home = readFileSync(`${DIST}docs/index.html`, "utf8");
const index = buildAgentIndex(docsPages(), sidebarOrder(home), {
  commit: commitOf(),
  readFile: (path) => readFileSync(resolve(DOCS, path), "utf8"),
  terms: termsOf(FORBIDDEN_TERMS),
  bindings: bindingsOf(EXPORT_ENTRIES, SDK_PACKAGES),
  groups: sidebarGroups(home),
});
const text = `${JSON.stringify(index, null, 2)}\n`;
parseAgentIndex(text);

const { pages, sections } = index.header;
if (pages === 0 || sections === 0) {
  console.error(`build-agent: FAIL pages=${pages} sections=${sections}`);
  process.exit(1);
}
mkdirSync(`${DIST}agent/`, { recursive: true });
writeFileSync(`${DIST}agent/index.json`, text);
console.log(`build-agent: PASS pages=${pages} sections=${sections}`);
