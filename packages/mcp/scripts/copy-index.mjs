// Copies the site's agent index next to the binary (plan 11e Task 5). The
// site build writes apps/site/dist/agent/index.json; the binary reads
// dist/agent/index.json by default. The copy is validated with the format's
// own parser, so the binary never loads a file that its parser refuses.
// It also refuses an index that is older than a page source. A copy of
// stale data with a PASS line proves nothing about the docs.
// It also writes dist/agent/skills.json beside the index: the skill pack,
// which the remote Worker reads from its assets (Task 16). Each skill must
// parse, and the prompt names must equal the stacks and the providers of the
// CLI, both ways (spec 21 item 13), or nothing is written.
// Run it through `pnpm turbo run index --filter=@authtempo/mcp`, which builds
// this package and the site first. The flags --source, --content, --target,
// and --skills name other paths, for the tests.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    skills: { type: "string", default: here("../skills/") },
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
const { readSkills } = await import("../dist/index-reader.js");
const { expectedPrompts, skillPrompts } = await import("../dist/prompts.js");
const { PROVIDERS, STACKS } = await import("@authtempo/cli/program");
const skills = readSkills(values.skills);
let names;
try {
  names = skillPrompts(skills, { bindings: index.header.bindings }).map((p) => p.name);
} catch (e) {
  console.error(`copy-index: FAIL ${e.message}`);
  process.exit(1);
}
const expected = expectedPrompts(STACKS, PROVIDERS);
const missing = expected.filter((n) => !names.includes(n));
const extra = names.filter((n) => !expected.includes(n));
if (missing.length > 0 || extra.length > 0) {
  console.error(
    `copy-index: FAIL the skills do not equal the prompts of the stacks and providers: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`,
  );
  process.exit(1);
}
mkdirSync(dirname(values.target), { recursive: true });
copyFileSync(values.source, values.target);
writeFileSync(join(dirname(values.target), "skills.json"), `${JSON.stringify(skills)}\n`);
console.log(`copy-index: PASS pages=${index.pages.length} skills=${skills.length}`);
