import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTag } from "../src/check-tag.ts";
import {
  CI_FILE,
  ENVIRONMENT,
  FIRST_RELEASE,
  NODE_FLOOR,
  NPM_FLOOR,
  SCOPE,
  TAG_PREFIX,
  WORKFLOW_FILE,
} from "../src/lib/release-facts.ts";
import { releasedNames } from "../src/lib/released.ts";
import { readWorkspace } from "../src/lib/workspace.ts";

// docs/release/RUNBOOK.md, the steps of the owner (plan 12j Task 13, spec 33
// item 4.3). A runbook runs on a person, so this test holds each value that
// it names to the value that the code consumes, and the order of its steps.
const ROOT = new URL("../../../", import.meta.url);
const ROOT_PATH = decodeURIComponent(ROOT.pathname);
const TEXT = readFileSync(new URL("docs/release/RUNBOOK.md", ROOT), "utf8");
const REPOSITORY = JSON.parse(readFileSync(new URL("release/repository.json", ROOT), "utf8")) as {
  url: string;
  owner: string;
  name: string;
};
const ROOT_PACKAGE = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const SCRIPTS = ROOT_PACKAGE.scripts;

/** The capital names of the runbook that name a file, not an export: the hash list of the job check. */
const FILE_NAMES = new Set(["SHA256SUMS"]);

/** The folders whose .ts files may export a capital name of the runbook. */
const EXPORT_DIRS = ["apps/site/src/data", "apps/site/scripts", "scripts/release/src"];
/** The one file outside those folders that exports a name of the runbook. */
const EXPORT_FILES = ["packages/core/src/schema.ts"];

/** The text of one `## ` section, without its heading, up to the next `## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`the runbook has no section "${heading}"`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start + heading.length + 5, end === -1 ? undefined : end);
}

/** The numbered steps of a section, each with its indented lines, up to its first `### `. */
function steps(text: string): string[] {
  const body = text.split(/^### /m)[0] ?? "";
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\d+\. /.test(line)) out.push(line);
    else if (out.length > 0 && /^\s+\S/.test(line)) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

/** The step of a section that starts with `<n>. `. */
function stepOf(text: string, heading: string, n: number): string {
  const step = steps(section(text, heading)).find((s) => s.startsWith(`${n}. `));
  if (step === undefined) throw new Error(`"${heading}" has no step ${n}`);
  return step;
}

/** The sentences of a step: the text split after each ". " or a line break. */
const sentencesOf = (step: string) =>
  step
    .replace(/^\d+\.\s+/, "")
    .split(/(?<=\.)\s+|\n\s*-\s*/)
    .map((s) => s.trim());

/** The faults of the once-only steps: a step with no consequence sentence. */
function consequenceFaults(text: string): string[] {
  return steps(section(text, "Once, before the first release"))
    .filter((s) => !sentencesOf(s).some((t) => t.startsWith("Without it,") || t.startsWith("If ")))
    .map((s) => `the step "${s.split("\n")[0]}" states no consequence (Without it, or If)`);
}

/** The index of the first step of all once and release steps that holds `needle`. */
function stepIndex(text: string, needle: string): number {
  const all = [
    "Once, before the first release",
    "At each release",
    "Once, after the first publish",
  ].flatMap((h) => steps(section(text, h)));
  return all.findIndex((s) => s.includes(needle));
}

/**
 * The order faults of the steps that the code needs in order. Ruling 21 of
 * plan 12j: the merge comes before the tag, because check-tag refuses a tag
 * that main lacks. A trusted publisher expires 2 days after its configuration
 * with no publish, so it comes after the merge and before the tag.
 */
function orderFaults(text: string): string[] {
  const faults: string[] = [];
  const environment = stepIndex(text, `Create the environment \`${ENVIRONMENT}\``);
  const merge = stepIndex(text, "Then merge it.");
  const publisher = stepIndex(text, "add a trusted publisher to each released package");
  const tag = stepIndex(text, `with \`${TAG_PREFIX}<version>\`, and push the tag`);
  const approve = stepIndex(text, "approve the job `publish`");
  const verify = stepIndex(text, "node scripts/release/src/verify-published.ts");
  const disallow = stepIndex(text, "Require two-factor authentication and disallow tokens");
  for (const [name, i] of Object.entries({
    environment,
    merge,
    publisher,
    tag,
    approve,
    verify,
    disallow,
  }))
    if (i === -1) faults.push(`the runbook has no ${name} step`);
  if (publisher <= environment)
    faults.push("the trusted publisher step comes before the environment step");
  if (tag <= merge) faults.push("the tag step comes before the merge step");
  if (publisher <= merge) faults.push("the trusted publisher step comes before the merge step");
  if (tag <= publisher) faults.push("the tag step comes before the trusted publisher step");
  if (approve <= tag) faults.push("the approval step comes before the tag step");
  if (verify <= approve) faults.push("the verify step comes before the approval step");
  if (disallow <= approve)
    faults.push("the step that disallows tokens comes before the first publish");
  return faults;
}

/** The text with the steps `a` and `b` of "At each release" swapped, numbers and all. */
function swapSteps(text: string, heading: string, a: number, b: number): string {
  const first = stepOf(text, heading, a);
  const second = stepOf(text, heading, b);
  return text.replace(first, "@@A@@").replace(second, first).replace("@@A@@", second);
}

/** The code spans of a text. */
const spans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");

/** Each `.ts` file under a folder of the repository, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(new URL(`${dir}/`, ROOT), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.includes("node_modules"))
    .map((f) => `${dir}/${f}`);
}

/** True when a file of `files` exports `name` as a const, a function, or a type. */
const exports = (files: readonly string[], name: string) =>
  files.some((f) =>
    new RegExp(`^export (?:const|function|interface|type) ${name}\\b`, "m").test(
      readFileSync(new URL(f, ROOT), "utf8"),
    ),
  );

describe("docs/release/RUNBOOK.md", () => {
  it("names the values that the code consumes", () => {
    for (const value of [
      `\`${WORKFLOW_FILE}\``,
      `\`${CI_FILE}\``,
      `environment \`${ENVIRONMENT}\``,
      `\`${TAG_PREFIX}<version>\``,
      `\`${NPM_FLOOR}\``,
      `\`${NODE_FLOOR}\``,
      `\`${FIRST_RELEASE}\``,
      `\`${SCOPE}\``,
      `\`${REPOSITORY.url}\``,
      `Organization or user: \`${REPOSITORY.owner}\`. Repository: \`${REPOSITORY.name}\`. Workflow filename: \`${WORKFLOW_FILE}\`. Environment name: \`${ENVIRONMENT}\`.`,
      "`security@authtempo.com`",
    ])
      expect(TEXT, value).toContain(value);
  });

  it("names the two workflows only, and the branch protection names CI_FILE", () => {
    const named = new Set(spans(TEXT).filter((s) => /^[\w.-]+\.ya?ml$/.test(s)));
    expect([...named].sort()).toEqual([CI_FILE, WORKFLOW_FILE].sort());
    expect(stepOf(TEXT, "Once, before the first release", 3)).toContain(
      `Require a pull request and the job \`check\` of \`${CI_FILE}\`.`,
    );
    expect(stepOf(TEXT, "At each release", 6)).toContain(`the job \`check\` of \`${CI_FILE}\``);
  });

  it("names the key form of RELEASE_DATES that the feed reads", () => {
    // The key of a row is entryKey of apps/site/scripts/lib/feed.ts.
    const feed = readFileSync(new URL("apps/site/scripts/lib/feed.ts", ROOT), "utf8");
    const body =
      /^export const entryKey = \(pkg: string, version: string\): string => `([^`]+)`;$/m.exec(
        feed,
      )?.[1];
    expect(body, "feed.ts has no entryKey of the form that this test reads").toBeDefined();
    // Each placeholder of the template becomes its name in the runbook.
    const names: Record<string, string> = { pkg: "<name>", version: "<version>" };
    const form = (body ?? "").replace(/\$\{(\w+)\}/g, (_m, v: string) => names[v] ?? `?${v}`);
    expect(form).toBe("<name>@<version>");
    const step = stepOf(TEXT, "At each release", 4);
    expect(step).toContain("`RELEASE_DATES`");
    expect(step).toContain(`The key is \`${form}\`.`);
    // The example time has the row form of check-feed: YYYY-MM-DDTHH:MM:SSZ.
    expect(step).toContain("in the form `YYYY-MM-DDTHH:MM:SSZ`");
    const example = /such as `([^`]+)`/.exec(step)?.[1] ?? "";
    expect(example).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(new Date(example).toISOString().replace(".000Z", "Z")).toBe(example);
  });

  it("names the branch form of a patch that check-tag reads", () => {
    const [failure] = checkTag({
      tag: `${TAG_PREFIX}7.8.0`,
      groupVersion: "7.8.0",
      onMain: false,
      onReleaseBranch: false,
    }).failures;
    const branch = /\brelease\/\S+/.exec(failure ?? "")?.[0] ?? "";
    expect(branch).toBe("release/7.8");
    const form = branch.replace("7", "<major>").replace("8", "<minor>");
    for (const s of spans(TEXT).filter((x) => x.startsWith("release/<")))
      expect(s, "a branch form of the runbook").toBe(form);
    expect(stepOf(TEXT, "At each release", 2)).toContain(`Do not name it \`${form}\`.`);
  });

  it("lists every released package, and no other scoped name", () => {
    const listed = [...TEXT.matchAll(/^- `(@authtempo\/[^`]+)`$/gm)].map((m) => m[1]);
    expect(listed).toEqual(releasedNames(ROOT_PATH));
    const named = new Set([...TEXT.matchAll(/`(@authtempo\/[a-z0-9-]+)/g)].map((m) => m[1]));
    for (const name of named) expect(releasedNames(ROOT_PATH), name).toContain(name);
  });

  it("states a consequence beside each once-only step", () => {
    expect(steps(section(TEXT, "Once, before the first release"))).toHaveLength(8);
    expect(consequenceFaults(TEXT)).toEqual([]);
    const without = TEXT.replace(
      "required reviewer. Add a deployment rule that allows the tags `v*` only. Without it,",
      "required reviewer. Add a deployment rule that allows the tags `v*` only. Then,",
    );
    expect(consequenceFaults(without)).toEqual([
      `the step "4. Create the environment \`release\` in the settings of the repository. Add yourself as the required reviewer. Add a deployment rule that allows the tags \`v*\` only. Then, GitHub makes the environment at the first run with no reviewer. The job \`publish\` then starts with no approval." states no consequence (Without it, or If)`,
    ]);
  });

  it("starts the step that makes the repository public with the warning", () => {
    const step = stepOf(TEXT, "Once, before the first release", 2);
    expect(step).toMatch(/^2\. WARNING: Read the whole git history for secrets before/);
    expect(step).toContain("`git log --all -p`");
    expect(step).toContain(
      `Then make the repository \`${REPOSITORY.owner}/${REPOSITORY.name}\` public.`,
    );
  });

  it("orders the steps as the code needs", () => {
    expect(orderFaults(TEXT)).toEqual([]);
    // The trusted publisher moved before the environment.
    const env = stepOf(TEXT, "Once, before the first release", 4);
    const publisher = stepOf(TEXT, "At each release", 7);
    const early = TEXT.replace(env, "@@E@@").replace(publisher, env).replace("@@E@@", publisher);
    expect(orderFaults(early)).toContain(
      "the trusted publisher step comes before the environment step",
    );
    // The tag before the merge (ruling 21).
    expect(orderFaults(swapSteps(TEXT, "At each release", 6, 8))).toContain(
      "the tag step comes before the merge step",
    );
    // The verify step before the approval.
    expect(orderFaults(swapSteps(TEXT, "At each release", 9, 10))).toEqual([
      "the verify step comes before the approval step",
    ]);
  });

  it("starts the servers and runs the check as the job check of release.yml does", () => {
    const commands = [
      "docker compose up -d --wait",
      "pnpm install --frozen-lockfile",
      "pnpm release:check",
    ];
    const step = stepOf(TEXT, "At each release", 1);
    const workflow = readFileSync(new URL(`.github/workflows/${WORKFLOW_FILE}`, ROOT), "utf8");
    const runs = [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1] ?? "");
    const at = (list: readonly string[]) =>
      commands.map((c) => list.findIndex((line) => line.startsWith(c)));
    const inStep = commands.map((c) => step.indexOf(`\`${c}\``));
    const inWorkflow = at(runs);
    for (const order of [inStep, inWorkflow]) {
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it("discards the output of changeset version with a glob that covers each changelog", () => {
    const step = stepOf(TEXT, "At each release", 3);
    const glob = "packages/*/CHANGELOG.md";
    expect(step).toContain(`Run \`git restore .\` and \`git clean -f -- '${glob}'\`.`);
    expect(step.indexOf("git clean")).toBeLessThan(step.indexOf("run this step again"));
    // changeset version writes CHANGELOG.md in the folder of each released package.
    const released = new Set(releasedNames(ROOT_PATH));
    const dirs = readWorkspace(ROOT_PATH)
      .filter((p) => released.has(p.name))
      .map((p) => p.dir);
    expect(dirs).toHaveLength(released.size);
    for (const dir of dirs) expect(dir, dir).toMatch(/^packages\/[^/]+$/);
  });

  it("runs verify-published after the publish, with no list of names", () => {
    const step = stepOf(TEXT, "At each release", 10);
    expect(step).toContain("`node scripts/release/src/verify-published.ts`");
    // verify-published reads releasedNames, so the step names no package.
    expect(step).not.toMatch(/@authtempo\//);
    expect(existsSync(new URL("release/fallback-published.json", ROOT))).toBe(true);
    expect(section(TEXT, "At each release")).toContain(
      "Use `npm publish <tarball> --access public --provenance=false` for each tarball.",
    );
  });

  // The LATER lists left with plan 12j Task 14, which added the last file and
  // the last name (ruling 52 of plan 12j). So each target exists now.
  it("names root scripts and files that exist", () => {
    let targets = 0;
    for (const m of TEXT.matchAll(/`pnpm ([a-z:-]+)/g)) {
      const name = m[1] ?? "";
      // pnpm install, a flag, or a binary of a root dev dependency (turbo) is no root script.
      if (name === "install" || name.startsWith("-") || name in ROOT_PACKAGE.devDependencies)
        continue;
      expect(Object.keys(SCRIPTS), `pnpm ${name}`).toContain(name);
      for (const target of (SCRIPTS[name] ?? "").matchAll(/\bnode (\S+\.(?:ts|mjs|js))\b/g)) {
        const file = target[1] ?? "";
        targets++;
        expect(existsSync(new URL(file, ROOT)), `${file} of pnpm ${name}`).toBe(true);
      }
    }
    expect(targets).toBeGreaterThan(0);
    const paths = [...TEXT.matchAll(/`((?:apps|docs|packages|release|scripts)\/[^`\s<]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(new URL(path, ROOT)), path).toBe(true);
  });

  it("names code that exists", () => {
    const files = [...EXPORT_DIRS.flatMap(tsFiles), ...EXPORT_FILES];
    const names = new Set(
      spans(TEXT).filter((s) => /^[A-Z][A-Z0-9_]+$/.test(s) && !FILE_NAMES.has(s)),
    );
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) expect(exports(files, name), name).toBe(true);
  });

  it("names each released package with its Node floor", () => {
    const released = new Set(releasedNames(ROOT_PATH));
    const manifests = readWorkspace(ROOT_PATH).filter((p) => released.has(p.name));
    expect(manifests).toHaveLength(released.size);
    const node = (p: (typeof manifests)[number]) => p.manifest.engines?.node ?? "";
    const floor = manifests
      .filter((p) => /^>=22\.13(\.0)?$/.test(node(p)))
      .map((p) => p.name)
      .sort();
    // Each other released package has the floor 22.
    for (const p of manifests)
      if (!floor.includes(p.name)) expect(node(p), p.name).toMatch(/^>=22(\.0){0,2}$/);
    const part = section(TEXT, "What the checks do not prove");
    const line = part.split("\n").find((l) => l.includes("The floor is 22.13 for"));
    const named = [...(line ?? "").matchAll(/`(@authtempo\/[^`]+)`/g)].map((m) => m[1]).sort();
    expect(named).toEqual(floor);
    expect(line).toContain("It is 22 for the other packages.");
  });
});
