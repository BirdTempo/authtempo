// check-resources (plan 12j Task 13, owner decision 6 of 2026-10-14, spec 33
// item 15). The Resources page against the release. It links CONTRIBUTING.md
// and SECURITY.md of the repository at every version. While core is at 0.0.0,
// it states RESOURCES_EMPTY and lists nothing. Above 0.0.0, it lists each
// released package by its npm page, each example folder, and the demo, both
// ways. So the version pull request of the first release adds the three
// lists, or this check fails. A package, an example, or the demo with two
// links fails at every version.
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The page, by its path under src/content/docs/. */
export const RESOURCES_PAGE = "docs/resources.md";
const NPM = "https://www.npmjs.com/package/";
/** The page of the demo on this site. */
export const DEMO_PATH = "/demo/";

export interface ResourcesInput {
  /** The version of core: the group version. */
  version: string;
  /** The source of the page, or "" when it is missing. */
  source: string;
  /** The released names: the fixed group. */
  released: readonly string[];
  /** Each folder name under examples/ whose package release/unreleased.json names. */
  examples: readonly string[];
  /** The url of release/repository.json. */
  repoUrl: string;
  /** RESOURCES_EMPTY. */
  empty: string;
}

/** Each Markdown link target of a source. */
const targets = (source: string) => [...source.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");

export function checkResources(input: ResourcesInput): CheckReport {
  const { version, source, released, examples, repoUrl } = input;
  const links = targets(source);
  const packages = links.filter((l) => l.startsWith(NPM)).map((l) => l.slice(NPM.length));
  const tree = `${repoUrl}/tree/main/examples/`;
  const folders = links.filter((l) => l.startsWith(tree)).map((l) => l.slice(tree.length));
  const demo = links.includes(DEMO_PATH);
  const r: CheckReport = {
    name: "check-resources",
    counts: {
      pages: source === "" ? 0 : 1,
      packages: packages.length,
      examples: folders.length,
      demo: demo ? 1 : 0,
      links: 0,
    },
    failures: [],
  };
  for (const [kind, items] of [
    ["the package", packages],
    ["the example", folders],
    ["the demo", links.filter((l) => l === DEMO_PATH)],
  ] as const)
    for (const item of new Set(items)) {
      const n = items.filter((i) => i === item).length;
      if (n > 1) r.failures.push(`the page links ${kind} ${item} ${n} times`);
    }
  for (const file of ["CONTRIBUTING.md", "SECURITY.md"]) {
    if (links.includes(`${repoUrl}/blob/main/${file}`)) r.counts.links = (r.counts.links ?? 0) + 1;
    else r.failures.push(`the page does not link ${file} (${repoUrl}/blob/main/${file})`);
  }
  if (version === "0.0.0") {
    if (!source.includes(input.empty))
      r.failures.push(`core is at 0.0.0, so the page must state: ${input.empty}`);
    r.exempt = ["no release exists, so the page lists no package, example, or demo"];
    for (const name of packages)
      r.failures.push(`core is at 0.0.0, and the page has a package row: ${name}`);
    for (const folder of folders)
      r.failures.push(`core is at 0.0.0, and the page has an example row: ${folder}`);
    if (demo) r.failures.push(`core is at 0.0.0, and the page links the demo ${DEMO_PATH}`);
  } else {
    if (source.includes(input.empty))
      r.failures.push(`core is at ${version}, so the page must not state: ${input.empty}`);
    for (const name of released)
      if (!packages.includes(name))
        r.failures.push(`the page has no row for the package ${name} (${NPM}${name})`);
    for (const name of packages)
      if (!released.includes(name))
        r.failures.push(`the page lists ${name}, which is not a released package`);
    for (const folder of examples)
      if (!folders.includes(folder))
        r.failures.push(`the page has no row for the example ${folder} (${tree}${folder})`);
    for (const folder of folders)
      if (!examples.includes(folder))
        r.failures.push(`the page lists the example ${folder}, which is not an example folder`);
    if (!demo) r.failures.push(`the page has no row for the demo (${DEMO_PATH})`);
  }
  return requireCounts(r, ["pages"]);
}
