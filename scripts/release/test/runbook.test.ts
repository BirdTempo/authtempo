import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT,
  FIRST_RELEASE,
  NODE_FLOOR,
  NPM_FLOOR,
  SCOPE,
  TAG_PREFIX,
  WORKFLOW_FILE,
} from "../src/lib/release-facts.ts";
import { releasedNames } from "../src/lib/released.ts";

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
const SCRIPTS = (
  JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

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

/** The order faults of the steps that the code needs in order. */
function orderFaults(text: string): string[] {
  const faults: string[] = [];
  const environment = stepIndex(text, `Create the environment \`${ENVIRONMENT}\``);
  const publisher = stepIndex(text, "add a trusted publisher to each released package");
  const tag = stepIndex(text, `with \`${TAG_PREFIX}<version>\`, and push the tag`);
  const approve = stepIndex(text, "approve the job `publish`");
  const disallow = stepIndex(text, "Require two-factor authentication and disallow tokens");
  for (const [name, i] of Object.entries({ environment, publisher, tag, approve, disallow }))
    if (i === -1) faults.push(`the runbook has no ${name} step`);
  if (publisher <= environment)
    faults.push("the trusted publisher step comes before the environment step");
  if (approve <= tag) faults.push("the approval step comes before the tag step");
  if (disallow <= approve)
    faults.push("the step that disallows tokens comes before the first publish");
  return faults;
}

describe("docs/release/RUNBOOK.md", () => {
  it("names the values that the code consumes", () => {
    for (const value of [
      `\`${WORKFLOW_FILE}\``,
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

  it("lists every released package, and no other scoped name", () => {
    const listed = [...TEXT.matchAll(/^- `(@authtempo\/[^`]+)`$/gm)].map((m) => m[1]);
    expect(listed).toEqual(releasedNames(ROOT_PATH));
    const named = new Set([...TEXT.matchAll(/`(@authtempo\/[a-z0-9-]+)/g)].map((m) => m[1]));
    for (const name of named) expect(releasedNames(ROOT_PATH), name).toContain(name);
  });

  it("states a consequence beside each once-only step", () => {
    expect(steps(section(TEXT, "Once, before the first release"))).toHaveLength(9);
    expect(consequenceFaults(TEXT)).toEqual([]);
    const without = TEXT.replace(
      "required reviewer. Add a deployment rule that allows the tags `v*` only. Without it,",
      "required reviewer. Add a deployment rule that allows the tags `v*` only. Then,",
    );
    expect(consequenceFaults(without)).toEqual([
      `the step "4. Create the environment \`release\` in the settings of the repository. Add yourself as the required reviewer. Add a deployment rule that allows the tags \`v*\` only. Then, GitHub makes the environment at the first run with no reviewer. The job \`publish\` then starts with no approval." states no consequence (Without it, or If)`,
    ]);
  });

  it("orders the steps as the code needs", () => {
    expect(orderFaults(TEXT)).toEqual([]);
    const once = section(TEXT, "Once, before the first release");
    const step4 = steps(once).find((s) => s.startsWith("4. ")) ?? "";
    const step9 = steps(once).find((s) => s.startsWith("9. ")) ?? "";
    // The trusted publisher moved before the environment.
    const swapped = TEXT.replace(step4, "@@4@@").replace(step9, step4).replace("@@4@@", step9);
    expect(orderFaults(swapped)).toContain(
      "the trusted publisher step comes before the environment step",
    );
  });

  it("names root scripts and files that exist", () => {
    for (const m of TEXT.matchAll(/`pnpm ([a-z:-]+)/g)) {
      const name = m[1] ?? "";
      if (name === "install") continue;
      expect(Object.keys(SCRIPTS), `pnpm ${name}`).toContain(name);
    }
    const paths = [...TEXT.matchAll(/`((?:apps|docs|packages|release|scripts)\/[^`\s<]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(new URL(path, ROOT)), path).toBe(true);
  });

  it("names each package with the Node floor 22.13", () => {
    const floor = readdirSync(new URL("packages/", ROOT))
      .filter((dir) => existsSync(new URL(`packages/${dir}/package.json`, ROOT)))
      .map(
        (dir) =>
          JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, ROOT), "utf8")) as {
            name: string;
            engines?: { node?: string };
          },
      )
      .filter((p) => p.engines?.node === ">=22.13")
      .map((p) => p.name)
      .sort();
    const line = section(TEXT, "What the checks do not prove")
      .split("\n")
      .find((l) => l.includes("The floor is 22.13 for"));
    const named = [...(line ?? "").matchAll(/`(@authtempo\/[^`]+)`/g)].map((m) => m[1]).sort();
    expect(named).toEqual(floor);
  });
});
