import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPY_BUILD,
  COPY_CHECK_PACK,
  COPY_INSTALL,
  COPY_PREPARE,
  packCommand,
  RELEASE_COPY_MARKER,
  RELEASED_FILTERS_SHELL,
  RELEASED_NAMES_SHELL,
  shellLine,
} from "./lib/release-copy.ts";
import {
  CI_FILE,
  ENVIRONMENT,
  NODE_FLOOR,
  TAG_PREFIX,
  WORKFLOW_FILE,
} from "./lib/release-facts.ts";
import { type Report, reportLines, requireCounts } from "./lib/report.ts";

/** One value of the YAML subset of the two workflows, with the line where it starts. */
export type YamlNode =
  | { kind: "map"; line: number; entries: Record<string, YamlNode> }
  | { kind: "list"; line: number; items: YamlNode[] }
  | { kind: "scalar"; line: number; value: string | null; comment: string | null };

/** A form outside the YAML subset. The check refuses the file. */
export class YamlForm extends Error {}

const KEY = /^([A-Za-z0-9_-]+):(?: (.*))?$/;
const isItem = (text: string) => text === "-" || text.startsWith("- ");
const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "" || line.trimStart().startsWith("#");

/**
 * Reads the YAML subset that the two workflows use. The subset has block
 * mappings with plain keys, block lists, and "|" blocks. It has plain and
 * quoted scalars with a comment, and the flow forms {} and ["a", "b"]. Every
 * other form throws, so a form that this reader does not know never passes
 * unread.
 */
export function readYaml(text: string): YamlNode {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, i) => {
    if (line.includes("\t")) throw new YamlForm(`line ${i + 1}: a tab`);
    if (/^(---|\.\.\.)\s*$/.test(line)) throw new YamlForm(`line ${i + 1}: a document marker`);
  });
  let i = 0;
  const skip = () => {
    while (i < lines.length && isBlank(lines[i] ?? "")) i++;
  };
  const current = () => lines[i] ?? "";

  function scalar(rest: string, line: number): YamlNode {
    if (/^[&*!]/.test(rest)) throw new YamlForm(`line ${line}: an anchor, an alias, or a tag`);
    const tail = (after: string): string | null => {
      const t = after.trim();
      if (t === "") return null;
      if (!t.startsWith("#")) throw new YamlForm(`line ${line}: text after a closed value`);
      return t.slice(1).trim();
    };
    const quote = rest.charAt(0);
    if (quote === '"' || quote === "'") {
      const end = rest.indexOf(quote, 1);
      if (end === -1) throw new YamlForm(`line ${line}: a quoted value with no end`);
      const value = rest.slice(1, end);
      if (value.includes("\\")) throw new YamlForm(`line ${line}: an escape in a quoted value`);
      return { kind: "scalar", line, value, comment: tail(rest.slice(end + 1)) };
    }
    if (rest.startsWith("{")) {
      if (!/^\{\}(\s|$)/.test(rest))
        throw new YamlForm(`line ${line}: a flow mapping other than {}`);
      tail(rest.slice(2));
      return { kind: "map", line, entries: {} };
    }
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end === -1) throw new YamlForm(`line ${line}: a flow list with no end`);
      const inner = rest.slice(1, end).trim();
      if (/[[\]{}]/.test(inner)) throw new YamlForm(`line ${line}: a flow form inside a flow list`);
      tail(rest.slice(end + 1));
      const items = inner === "" ? [] : inner.split(",").map((part) => scalar(part.trim(), line));
      return { kind: "list", line, items };
    }
    if (/^[>|]/.test(rest)) throw new YamlForm(`line ${line}: a block scalar other than |`);
    const at = rest.indexOf(" #");
    const value = (at === -1 ? rest : rest.slice(0, at)).trim();
    if (value.includes(": ")) throw new YamlForm(`line ${line}: a mapping on one line`);
    return { kind: "scalar", line, value, comment: at === -1 ? null : rest.slice(at + 2).trim() };
  }

  /** The value after `key:` with nothing on its line: a deeper block, or null. */
  function deeper(indent: number, line: number): YamlNode {
    skip();
    if (i < lines.length && indentOf(current()) > indent) return block(indentOf(current()));
    return { kind: "scalar", line, value: null, comment: null };
  }

  /** A "|" block: each deeper line, without its common indent, with one line end. */
  function literal(indent: number): string {
    const body: string[] = [];
    while (i < lines.length && (current().trim() === "" || indentOf(current()) > indent)) {
      body.push(current());
      i++;
    }
    while (body.length > 0 && (body[body.length - 1] ?? "").trim() === "") body.pop();
    const cut = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
    return body.map((l) => l.slice(cut)).join("\n") + (body.length > 0 ? "\n" : "");
  }

  function map(indent: number): YamlNode {
    const node: YamlNode = { kind: "map", line: i + 1, entries: {} };
    for (skip(); i < lines.length; skip()) {
      const at = indentOf(current());
      if (at < indent) break;
      const line = i + 1;
      if (at > indent) throw new YamlForm(`line ${line}: an indent that no key opens`);
      const text = current().slice(at);
      if (isItem(text)) throw new YamlForm(`line ${line}: a list item beside a key`);
      const m = KEY.exec(text);
      if (m === null) throw new YamlForm(`line ${line}: a line that is not key: value`);
      const key = m[1] ?? "";
      if (key === "__proto__") throw new YamlForm(`line ${line}: the key __proto__`);
      if (Object.hasOwn(node.entries, key))
        throw new YamlForm(`line ${line}: the key ${key} again`);
      const rest = (m[2] ?? "").trim();
      i++;
      if (rest === "") node.entries[key] = deeper(indent, line);
      else if (rest === "|")
        node.entries[key] = { kind: "scalar", line, value: literal(indent), comment: null };
      else node.entries[key] = scalar(rest, line);
    }
    return node;
  }

  function list(indent: number): YamlNode {
    const node: YamlNode = { kind: "list", line: i + 1, items: [] };
    for (skip(); i < lines.length; skip()) {
      const at = indentOf(current());
      if (at < indent) break;
      const line = i + 1;
      if (at > indent) throw new YamlForm(`line ${line}: an indent that no item opens`);
      const text = current().slice(at);
      if (!isItem(text)) throw new YamlForm(`line ${line}: a key beside a list item`);
      const rest = text.slice(2).trim();
      if (rest === "") {
        i++;
        node.items.push(deeper(indent, line));
      } else if (KEY.test(rest)) {
        // The first key of a mapping item sits on the line of its "-".
        lines[i] = `${" ".repeat(indent + 2)}${rest}`;
        node.items.push(map(indent + 2));
      } else {
        i++;
        node.items.push(scalar(rest, line));
      }
    }
    return node;
  }

  function block(indent: number): YamlNode {
    skip();
    return isItem(current().slice(indent)) ? list(indent) : map(indent);
  }

  skip();
  if (i >= lines.length) throw new YamlForm("line 1: an empty file");
  if (indentOf(current()) !== 0) throw new YamlForm(`line ${i + 1}: an indent at the top`);
  // block(0) reads to the end of the file, because no line has an indent below 0.
  const root = block(0);
  if (root.kind !== "map") throw new YamlForm("line 1: a top that is not a mapping");
  return root;
}

/** A JavaScript form of a YAML value: null, a string, a list, or a mapping. */
type Shape = null | string | Shape[] | { [key: string]: Shape };

/** True when `node` is exactly `shape`: the same keys, the same items, the same values. */
function same(node: YamlNode | undefined, shape: Shape): boolean {
  if (node === undefined) return false;
  if (shape === null || typeof shape === "string")
    return node.kind === "scalar" && node.value === shape;
  if (Array.isArray(shape))
    return (
      node.kind === "list" &&
      node.items.length === shape.length &&
      shape.every((s, k) => same(node.items[k], s))
    );
  if (node.kind !== "map") return false;
  const keys = Object.keys(shape);
  return (
    Object.keys(node.entries).length === keys.length &&
    keys.every((k) => same(node.entries[k], shape[k] ?? null))
  );
}

const entriesOf = (node: YamlNode | undefined): Record<string, YamlNode> =>
  node?.kind === "map" ? node.entries : {};
const scalarOf = (node: YamlNode | undefined): string | null | undefined =>
  node?.kind === "scalar" ? node.value : undefined;

/** The release copy of release.yml, where prepare, the build, and the pack run. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template.
const COPY = "${{ runner.temp }}/release-copy";

interface Step {
  /** The action, owner/repo, of a uses step. */
  uses?: string;
  /** The text of a run step, without its last line end. */
  run?: string;
  /** The name of the step. A step with no name here has no name key. */
  name?: string;
  /** A run step in the release copy. */
  copy?: true;
  /** A checkout with the full history (fetch-depth: 0). */
  history?: true;
}

const checkout = (history: boolean): Step =>
  history ? { uses: "actions/checkout", history: true } : { uses: "actions/checkout" };
const PNPM: Step = { uses: "pnpm/action-setup" };
const NODE: Step = { uses: "actions/setup-node" };

/** The keys of each job, and its steps in order. */
interface Job {
  keys: string[];
  steps: Step[];
}

/**
 * The jobs of each file. A key that this table does not name fails. A step
 * that is gone, new, or moved fails too. So a change of a workflow changes
 * this table in the same commit. The comment above each step in the workflow
 * says what breaks without it.
 */
const JOBS: Record<string, Record<string, Job>> = {
  [CI_FILE]: {
    check: {
      keys: ["runs-on", "steps"],
      steps: [
        checkout(true),
        PNPM,
        NODE,
        { run: "docker compose up -d --wait" },
        { run: "pnpm install --frozen-lockfile" },
        { run: "pnpm release:check --no-osv --no-dry-run --base origin/main" },
      ],
    },
  },
  [WORKFLOW_FILE]: {
    check: {
      keys: ["runs-on", "permissions", "steps"],
      steps: [
        checkout(true),
        PNPM,
        NODE,
        { name: "Check the tag", run: 'node scripts/release/src/check-tag.ts "$GITHUB_REF_NAME"' },
        { run: "docker compose up -d --wait" },
        { run: "pnpm install --frozen-lockfile" },
        // A tag checkout has no local main (ruling 16 of plan 12j).
        { run: "pnpm release:check --base origin/main" },
        {
          name: "Make the release copy",
          run: [
            'mkdir "$RUNNER_TEMP/release-copy"',
            'git archive HEAD | tar -x -C "$RUNNER_TEMP/release-copy"',
            `touch "$RUNNER_TEMP/release-copy/${RELEASE_COPY_MARKER}"`,
          ].join("\n"),
        },
        // The commands of the release copy come from src/lib/release-copy.ts,
        // which the dry run also runs (ruling 21 of plan 12j).
        { run: shellLine(COPY_INSTALL), copy: true },
        { name: "Prepare the manifests", run: shellLine(COPY_PREPARE), copy: true },
        { run: `${shellLine(COPY_BUILD)} ${RELEASED_FILTERS_SHELL}`, copy: true },
        {
          name: "Pack each released package",
          run: [
            "mkdir out",
            `for name in ${RELEASED_NAMES_SHELL}; do`,
            `  ${shellLine(packCommand('"$name"', '"$PWD/out"'))}`,
            "done",
          ].join("\n"),
          copy: true,
        },
        { run: `${shellLine(COPY_CHECK_PACK)} out/*.tgz`, copy: true },
        {
          name: "Write the SHA-256 list",
          run: "cd out && sha256sum -- *.tgz > SHA256SUMS",
          copy: true,
        },
        { uses: "actions/upload-artifact" },
      ],
    },
    publish: {
      keys: ["needs", "runs-on", "environment", "permissions", "steps"],
      steps: [
        checkout(false),
        NODE,
        { uses: "actions/download-artifact" },
        { run: "node scripts/release/src/publish.ts out" },
      ],
    },
  },
};

/** The top-level keys of each file. Any other key, such as defaults or env, fails. */
const TOP_KEYS = ["name", "on", "permissions", "jobs"];

/**
 * The with keys of each action. Any other key fails, because a key such as
 * repository, ref, or run-id makes the step read another source.
 */
const WITH_KEYS: Record<string, (step: Step | undefined) => string[]> = {
  "actions/checkout": (step) =>
    step?.history === true ? ["fetch-depth", "persist-credentials"] : ["persist-credentials"],
  "actions/setup-node": () => ["node-version", "package-manager-cache"],
  "pnpm/action-setup": () => [],
  "actions/upload-artifact": () => ["name", "path", "if-no-files-found"],
  "actions/download-artifact": () => ["name", "path"],
};

/** The reason of a with key that the rule refuses, where the key has a known effect. */
const WITH_REASONS: Record<string, string> = {
  "registry-url": "it writes an .npmrc for a token",
  cache: "a cache is never evidence",
  version: "the packageManager field of package.json is the one source",
};

/** The files of the checkout and the root scripts of package.json. The test replaces both. */
export interface Tree {
  exists(path: string): boolean;
  scripts: Record<string, string>;
}

/** The pnpm commands of the workflows that are not root scripts. */
const PNPM_COMMANDS = ["install", "turbo"];

const nodePaths = (text: string) =>
  [...text.matchAll(/\bnode\s+([\w./-]+)/g)].map((m) => m[1] ?? "");

/**
 * The failures of one run line whose script file does not exist. A missing
 * file fails on the release day, so it fails here first.
 */
function pathFailures(run: string, tree: Tree): string[] {
  const out: string[] = [];
  for (const path of nodePaths(run)) if (!tree.exists(path)) out.push(`${path} does not exist`);
  for (const m of run.matchAll(/\bpnpm\s+([^\s-]\S*)/g)) {
    const name = m[1] ?? "";
    if (PNPM_COMMANDS.includes(name)) continue;
    const script = tree.scripts[name];
    if (script === undefined) out.push(`pnpm ${name} is not a root script of package.json`);
    else
      for (const path of nodePaths(script))
        if (!tree.exists(path)) out.push(`pnpm ${name} runs ${path}, which does not exist`);
  }
  return out;
}

/** The jobs of each file, and the one job that may mint an OIDC token. */
const PUBLISH_JOB = "publish";

const PIN = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PUBLISH_COMMAND = /\b(?:npm|pnpm|yarn|changeset)\s+publish\b/;
const TOKEN = /\bsecrets\b|\bgithub\.token\b|\bGITHUB_TOKEN\b|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/;

/** -1, 0, or 1 for two versions of the form x.y.z. */
function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let k = 0; k < 3; k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The rules of the `with` keys of one uses step. */
function checkWith(action: string, step: Step | undefined, w: Record<string, YamlNode>): string[] {
  const out: string[] = [];
  const allowed = WITH_KEYS[action]?.(step) ?? [];
  for (const key of Object.keys(w))
    if (!allowed.includes(key))
      out.push(
        `${action} has the with key ${key}; ${WITH_REASONS[key] ?? "the rule names no such key"}`,
      );
  if (action === "actions/checkout") {
    if (scalarOf(w["persist-credentials"]) !== "false")
      out.push("the checkout keeps its token in the git config");
    if (step?.history === true && scalarOf(w["fetch-depth"]) !== "0")
      out.push("the checkout has no full history (fetch-depth: 0)");
  } else if (action === "actions/setup-node") {
    const v = scalarOf(w["node-version"]) ?? "";
    if (!VERSION.test(v) || compare(v, NODE_FLOOR) < 0)
      out.push(`node-version ${v} is not a full version at or above ${NODE_FLOOR}`);
    if (scalarOf(w["package-manager-cache"]) !== "false")
      out.push("the setup-node cache is on; a cache is never evidence");
  } else if (action === "actions/upload-artifact") {
    if (
      scalarOf(w.name) !== "tarballs" ||
      scalarOf(w.path) !== `${COPY}/out/` ||
      scalarOf(w["if-no-files-found"]) !== "error"
    )
      out.push(
        `the upload is not the artifact tarballs of ${COPY}/out/ with if-no-files-found: error`,
      );
  } else if (action === "actions/download-artifact") {
    if (scalarOf(w.name) !== "tarballs" || scalarOf(w.path) !== "out")
      out.push("the download is not the artifact tarballs in out");
  }
  return out;
}

function checkJob(
  file: string,
  name: string,
  job: YamlNode,
  tree: Tree,
  counts: { uses: number; pinned: number },
  fail: (message: string) => void,
): void {
  const at = `jobs.${name}`;
  const e = entriesOf(job);
  const rule = JOBS[file]?.[name] ?? { keys: [], steps: [] };
  for (const key of Object.keys(e))
    if (!rule.keys.includes(key)) fail(`${at}: the key ${key} is not in the rule of the job`);
  const runsOn = e["runs-on"];
  if (runsOn?.kind !== "scalar") fail(`${at}: runs-on is not one label`);
  else if (!/^ubuntu-\d+\.\d+$/.test(runsOn.value ?? ""))
    fail(`${at}: runs-on ${runsOn.value} is not an ubuntu-<version> runner of GitHub`);

  const publishJob = file === WORKFLOW_FILE && name === PUBLISH_JOB;
  if (publishJob) {
    if (!same(e.permissions, { "id-token": "write", contents: "read" }))
      fail(`${at}: the permissions are not { id-token: write, contents: read }`);
    if (!same(e.environment, ENVIRONMENT)) fail(`${at}: the environment is not ${ENVIRONMENT}`);
    if (!same(e.needs, "check")) fail(`${at}: needs is not check`);
  } else if (e.permissions !== undefined) {
    if (e.permissions.kind !== "map") fail(`${at}: the permissions are not a mapping`);
    for (const [key, value] of Object.entries(entriesOf(e.permissions))) {
      if (key === "id-token")
        fail(`${at}: id-token: write; only jobs.${PUBLISH_JOB} may mint a token`);
      else if (key !== "contents")
        fail(`${at}: the permission ${key}; a job here reads only contents`);
      else if (scalarOf(value) !== "read")
        fail(`${at}: the permission ${key}: ${scalarOf(value)}; a job here only reads`);
    }
  }

  const steps = e.steps?.kind === "list" ? e.steps.items : [];
  steps.forEach((node, k) => {
    const s = entriesOf(node);
    const where = `${at} step ${k + 1}`;
    const uses = scalarOf(s.uses);
    if (typeof uses === "string") {
      counts.uses++;
      const pin = PIN.exec(uses);
      if (pin === null) fail(`${where}: ${uses} is not pinned to a 40-character commit SHA`);
      else {
        counts.pinned++;
        const comment = s.uses?.kind === "scalar" ? s.uses.comment : null;
        if (!/^v\d+\.\d+\.\d+$/.test(comment ?? ""))
          fail(`${where}: ${uses} has no version comment # v<major>.<minor>.<patch>`);
      }
      const action = uses.split("@")[0] ?? "";
      for (const message of checkWith(action, rule.steps[k], entriesOf(s.with)))
        fail(`${where}: ${message}`);
    }
    const run = scalarOf(s.run);
    if (typeof run === "string") {
      if (run.includes("${{"))
        fail(`${where}: an expression in a run line; pass the value through env`);
      if (PUBLISH_COMMAND.test(run))
        fail(`${where}: a publish command outside node scripts/release/src/publish.ts`);
      for (const message of pathFailures(run, tree)) fail(`${where}: ${message}`);
    }
  });

  if (steps.length !== rule.steps.length) {
    fail(`${at}: ${steps.length} steps, not the ${rule.steps.length} steps of the rule`);
    return;
  }
  steps.forEach((node, k) => {
    const want = rule.steps[k];
    if (want === undefined) return;
    const s = entriesOf(node);
    const label = want.uses ?? want.name ?? want.run ?? "";
    const uses = scalarOf(s.uses);
    const run = scalarOf(s.run);
    const ok =
      want.uses !== undefined
        ? typeof uses === "string" && uses.split("@")[0] === want.uses && run === undefined
        : typeof run === "string" && run.replace(/\n$/, "") === want.run && uses === undefined;
    if (!ok) {
      fail(`${at}: step ${k + 1} is not ${label}`);
      return;
    }
    // A key such as if, continue-on-error, env, or shell changes what the step does.
    const keys = want.uses !== undefined ? ["uses", "with"] : ["run"];
    if (want.name !== undefined) keys.push("name");
    if (want.copy === true) keys.push("working-directory");
    for (const key of Object.keys(s))
      if (!keys.includes(key))
        fail(`${at} step ${k + 1}: the key ${key} is not in the rule of the step`);
    if (want.name !== undefined && scalarOf(s.name) !== want.name)
      fail(`${at}: step ${k + 1} is not named ${want.name}`);
    if (want.copy === true && scalarOf(s["working-directory"]) !== COPY)
      fail(`${at}: step ${k + 1} is not in the release copy`);
  });
}

function checkFile(
  file: string,
  text: string,
  tree: Tree,
  counts: { uses: number; pinned: number },
  fail: (message: string) => void,
): void {
  text.split("\n").forEach((line, k) => {
    if (!line.trimStart().startsWith("#") && TOKEN.test(line))
      fail(`line ${k + 1}: a token or a secret; trusted publishing uses no token`);
  });
  let root: YamlNode;
  try {
    root = readYaml(text);
  } catch (error) {
    if (!(error instanceof YamlForm)) throw error;
    fail(error.message);
    return;
  }
  const top = entriesOf(root);
  for (const key of Object.keys(top))
    if (!TOP_KEYS.includes(key)) fail(`the top-level key ${key} is not in the rule`);

  const on = top.on;
  for (const trigger of ["pull_request_target", "workflow_run"])
    if (entriesOf(on)[trigger] !== undefined)
      fail(`the trigger ${trigger} runs with the secrets of the repository`);
  if (file === CI_FILE) {
    if (!same(on, { pull_request: null, push: { branches: ["main"] } }))
      fail('on is not { pull_request, push: { branches: ["main"] } }');
  } else if (!same(on, { push: { tags: [`${TAG_PREFIX}*`] } }))
    fail(`on is not { push: { tags: ["${TAG_PREFIX}*"] } }`);

  const permissions = top.permissions;
  if (file === CI_FILE) {
    if (!same(permissions, { contents: "read" }))
      fail("the top-level permissions are not { contents: read }");
  } else if (!same(permissions, {})) fail("the top-level permissions are not {}");
  if (entriesOf(permissions)["id-token"] !== undefined)
    fail(`id-token: write at the top level; only jobs.${PUBLISH_JOB} may mint a token`);

  const jobs = entriesOf(top.jobs);
  const want = Object.keys(JOBS[file] ?? {});
  if (Object.keys(jobs).join(",") !== want.join(",")) fail(`the jobs are not ${want.join(", ")}`);
  for (const [name, job] of Object.entries(jobs)) checkJob(file, name, job, tree, counts, fail);
}

/**
 * The rules of spec 33 item 5 over the two workflows. Each action is pinned to
 * a commit SHA with its version. The triggers and the permissions are the
 * least, and only the job publish has id-token: write and the environment.
 * Each runner is GitHub-hosted. No run line holds an expression, and no line
 * names a token. Each level holds only the keys of its rule, each step is in
 * its order, and each script file exists.
 */
export function checkWorkflows(input: {
  files: { name: string; text: string }[];
  tree: Tree;
}): Report {
  const failures: string[] = [];
  const counts = { files: 0, uses: 0, pinned: 0 };
  const names = input.files.map((f) => f.name);
  for (const file of [CI_FILE, WORKFLOW_FILE])
    if (!names.includes(file)) failures.push(`${file}: the file is missing`);
  for (const { name, text } of input.files) {
    counts.files++;
    const fail = (message: string) => failures.push(`${name}: ${message}`);
    if (name !== CI_FILE && name !== WORKFLOW_FILE) {
      fail(`another workflow; a workflow needs its rules in check-workflows`);
      continue;
    }
    checkFile(name, text, input.tree, counts, fail);
  }
  return requireCounts({ name: "check-workflows", counts, failures, notes: [] }, ["files"]);
}

/** Each file of .github/workflows/ under `root`, the files of `root`, and its root scripts. */
export function readInput(root: string): {
  files: { name: string; text: string }[];
  tree: Tree;
} {
  const dir = join(root, ".github/workflows");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const tree: Tree = {
    exists: (path) => existsSync(join(root, path)),
    scripts: manifest.scripts ?? {},
  };
  if (!existsSync(dir)) return { files: [], tree };
  return {
    files: readdirSync(dir)
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })),
    tree,
  };
}

/** Runs the check on the checkout at `root`, and returns the lines to print and the exit code. */
export function entry(root: string): { lines: string[]; code: number } {
  const report = checkWorkflows(readInput(root));
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = entry(fileURLToPath(new URL("../../../", import.meta.url)));
  for (const line of lines) console.log(line);
  process.exit(code);
}
