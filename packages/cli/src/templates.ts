import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { STACK_INFO, STACKS, type Stack, type StackInfo } from "./stacks.js";

/**
 * The init templates (spec 19, the one-source rule). Each stack is an
 * example app of the docs site (plan 11a) with the declared rewrites below
 * and nothing else, so a tutorial page, its example, and a scaffold cannot
 * drift. The build renders them into dist/templates.json; a test renders
 * them again and compares. `init` takes the stack list and the steps from
 * this file, and the files from the JSON. The stack names and STACK_INFO
 * live in stacks.ts, which imports nothing.
 */
export { STACK_INFO, STACKS, type Stack, type StackInfo };

/** The folders that an example holds after an install or a run: never part of a template. */
const SKIP = new Set(["node_modules", ".wrangler", "dist", ".turbo"]);

/**
 * The dot files that an example may hold. The walker reads the file system,
 * not git, so a git-ignored .dev.vars or .env with a real secret, or a
 * .DS_Store, could reach dist/templates.json and the pack. Any other dot
 * file or folder stops the build. An allowlist, not `git ls-files`: the
 * build and the drift test then need no git checkout, and a stray file
 * fails loudly instead of being dropped with no message.
 */
const DOT_ALLOWED = new Set([".gitignore", ".dev.vars.example", ".env.example"]);

/** The files of an example app, relative and sorted. */
export function exampleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.name.startsWith(".") && !DOT_ALLOWED.has(e.name))
        throw new Error(
          `${p}: no template may hold this dot file; remove it, or add it to DOT_ALLOWED in src/templates.ts`,
        );
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * True while the CLI is unpublished: its own package.json is private or at
 * version 0.0.0. The note below then goes into the next steps and the
 * scaffold README; it removes itself at publication.
 */
export const UNPUBLISHED: boolean = (() => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    private?: boolean;
    version: string;
  };
  return pkg.private === true || pkg.version === "0.0.0";
})();
/**
 * The scaffold does not depend on @authtempo/cli, so `authtempo` in the next
 * steps is on no path until publication. The note gives the documented run
 * form (test/documented-run.test.ts holds it to the docs page): node with the
 * absolute path of the clone, run in the folder of the app, so each relative
 * path resolves there and exit 2 stays exit 2.
 */
export const UNPUBLISHED_NOTE =
  "The packages are not on a registry yet: pnpm install works only inside the authtempo workspace until they are published. Until then, run each authtempo step as node /path/to/authtempo/packages/cli/dist/bin/authtempo.js in the folder of the app. Write the path of your clone in place of /path/to/authtempo.";

const BASE_EXTENDS = '"extends": "../../tsconfig.base.json"';
/** The test script of the D1 examples: its bundle proof is a file of the repo, not of the app. */
const D1_TEST = "vitest run && node ../worker/proof/bundle-no-node.mjs .";
/** The stacks whose example has D1_TEST as its test script. */
const D1_STACKS: ReadonlySet<Stack> = new Set(["workers-d1", "mcp-server"]);

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * The declared rewrites (plan 11c, deviation 5). A scaffold lives outside
 * the repo, so its name is my-app. Each workspace:* is the CLI's version,
 * because the packages release together. Each tsconfig extends the
 * scaffold's own copy of the base config. The test script of a D1 stack
 * drops the repo's bundle proof. The Bun stack starts with bun. A rewrite that finds an unexpected
 * text throws, so a change of an example fails the build, not the scaffold.
 */
export function rewrite(stack: Stack, path: string, text: string, version: string): string {
  if (path === "package.json") {
    const pkg = JSON.parse(text) as PackageJson;
    pkg.name = "my-app";
    for (const deps of [pkg.dependencies, pkg.devDependencies])
      if (deps)
        for (const [k, v] of Object.entries(deps)) if (v === "workspace:*") deps[k] = version;
    if (D1_STACKS.has(stack)) {
      if (pkg.scripts?.test !== D1_TEST)
        throw new Error(
          `examples/${STACK_INFO[stack].example}: the test script is not "${D1_TEST}"`,
        );
      pkg.scripts.test = "vitest run";
    }
    if (stack === "bun") {
      if (pkg.scripts?.start !== "node src/main.ts")
        throw new Error('examples/node: the start script is not "node src/main.ts"');
      pkg.scripts.start = "bun src/main.ts";
    }
    return `${JSON.stringify(pkg, null, 2)}\n`;
  }
  if (/^tsconfig[^/]*\.json$/.test(path)) {
    if (!text.includes(BASE_EXTENDS))
      throw new Error(`${path} of ${stack} does not extend the repo's base config`);
    return text.replace(BASE_EXTENDS, '"extends": "./tsconfig.base.json"');
  }
  return text;
}

/** The three files that each stack adds: the README, the ignore list, and the list of the secrets with no value. */
export function extraFiles(stack: Stack): TemplateFile[] {
  const info = STACK_INFO[stack];
  const steps = ["pnpm install", ...info.next];
  const readme = [
    "# my-app",
    "",
    `An app with authtempo sign-in on ${info.label}. \`authtempo init --stack ${stack}\` wrote it from the example app \`examples/${info.example}\` of the authtempo repo.`,
    "",
    "## Next",
    "",
    ...steps.map((s, i) => `${i + 1}. Run \`${s}\`.`),
    "",
    ...(UNPUBLISHED ? [UNPUBLISHED_NOTE, ""] : []),
    `\`${info.secrets}\` lists each secret with no value. Do not commit a copy with values: \`.gitignore\` lists it.`,
    "",
    "## Links",
    "",
    `- The tutorial: https://authtempo.com/docs/start/${info.page}/`,
    "- Deploy: https://authtempo.com/docs/operations/deploy/",
    "- The CLI: https://authtempo.com/docs/reference/cli/",
    "",
  ].join("\n");
  const gitignore = ["node_modules", ".wrangler/", ".dev.vars", ".env", "dist", ""].join("\n");
  const secrets =
    info.secrets === ".dev.vars.example"
      ? [
          "# The secrets of wrangler dev. Copy this file to .dev.vars, which git ignores.",
          "# AUTH_SECRET: at least 32 characters and 100 bits or more. Make one with: openssl rand -base64 32",
          "# On Cloudflare, store it with: pnpm exec wrangler secret put AUTH_SECRET",
          "AUTH_SECRET=",
          "",
        ]
      : [
          "# The settings of the server. Copy this file to .env, which git ignores.",
          "# AUTH_SECRET: at least 32 characters and 100 bits or more. Make one with: openssl rand -base64 32",
          "AUTH_SECRET=",
          "# DATABASE_URL: the connection string of your Postgres database.",
          "DATABASE_URL=",
          "# BASE_URL: the origin where the server answers.",
          "BASE_URL=http://127.0.0.1:3000",
          "",
        ];
  return [
    { path: "README.md", text: readme },
    { path: ".gitignore", text: gitignore },
    { path: info.secrets, text: secrets.join("\n") },
  ];
}

export interface TemplateFile {
  path: string;
  text: string;
}

/**
 * dist/templates.json of this package: the build renders it
 * (scripts/copy-templates.mjs). The path goes through `..`, so src and dist
 * both reach the built file, as version.ts reads package.json.
 */
export const TEMPLATES_FILE = fileURLToPath(new URL("../dist/templates.json", import.meta.url));

/**
 * The rendered templates of each stack, one reader for `init` and `info`
 * (plan 11c2). `init` reads through its io; `info` reads the file system.
 */
export function readTemplates(read: (path: string) => string): Record<Stack, TemplateFile[]> {
  return JSON.parse(read(TEMPLATES_FILE)) as Record<Stack, TemplateFile[]>;
}

const byPath = (a: TemplateFile, b: TemplateFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** The files of one stack: the example's files with the rewrites, the base config, and the extra files. */
export function renderStack(stack: Stack, repo: string, version: string): TemplateFile[] {
  const dir = join(repo, "examples", STACK_INFO[stack].example);
  const files = exampleFiles(dir).map((path) => ({
    path,
    text: rewrite(stack, path, readFileSync(join(dir, path), "utf8"), version),
  }));
  const added = [
    { path: "tsconfig.base.json", text: readFileSync(join(repo, "tsconfig.base.json"), "utf8") },
    ...extraFiles(stack),
  ];
  for (const a of added)
    if (files.some((f) => f.path === a.path))
      throw new Error(`examples/${STACK_INFO[stack].example} holds ${a.path}, which init adds`);
  return [...files, ...added].sort(byPath);
}

export function renderAll(repo: string, version: string): Record<Stack, TemplateFile[]> {
  return Object.fromEntries(STACKS.map((s) => [s, renderStack(s, repo, version)])) as Record<
    Stack,
    TemplateFile[]
  >;
}
