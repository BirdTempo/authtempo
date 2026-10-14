import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INIT_JSON_KEYS } from "../src/json.js";
import {
  exampleFiles,
  extraFiles,
  renderStack,
  rewrite,
  STACK_INFO,
  STACKS,
  type Stack,
  type TemplateFile,
  UNPUBLISHED,
  UNPUBLISHED_NOTE,
} from "../src/templates.js";
import { assertFreshBuild, linesOf, PKG, REPO, runBin } from "./support/bin.js";

const VERSION = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string })
  .version;
const TEST_SECRET = "0123456789abcdef0123456789abcdef";
let templates: Record<Stack, TemplateFile[]>;
const PKG_JSON = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  private?: boolean;
  version: string;
};

/** The folders under .scaffold that this file made, and those of a failed test, kept for diagnosis. */
const made: string[] = [];
const kept = new Set<string>();
const fresh = (name: string) => {
  const dir = join(PKG, ".scaffold", `${name}-${crypto.randomUUID().slice(0, 8)}`);
  made.push(dir);
  return dir;
};

beforeEach(({ onTestFailed }) => {
  const start = made.length;
  onTestFailed(() => {
    for (const dir of made.slice(start)) kept.add(dir);
  });
});

afterAll(() => {
  for (const dir of made) if (!kept.has(dir)) rmSync(dir, { recursive: true, force: true });
  if (kept.size > 0) console.error(`kept for diagnosis: ${[...kept].join(", ")}`);
});

beforeAll(() => {
  assertFreshBuild();
  templates = JSON.parse(readFileSync(join(PKG, "dist/templates.json"), "utf8")) as Record<
    Stack,
    TemplateFile[]
  >;
});

/**
 * The secrets that a file must not hold (spec 19): a private key, a filled
 * AUTH_SECRET or DATABASE_URL line, a URL with a password on a host other
 * than this machine, and a long token other than the documented test
 * secret and the all-zero placeholder ids of the examples.
 */
function secretsIn(path: string, text: string): string[] {
  const found: string[] = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) found.push(`${path}: a private key`);
  for (const m of text.matchAll(/^(AUTH_SECRET|DATABASE_URL)=(\S+)/gm))
    found.push(`${path}: ${m[1]} holds a value`);
  for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:[^\s@/"'`]+@([^\s/:"'`]+)/gi))
    if (m[1] !== "localhost" && m[1] !== "127.0.0.1") found.push(`${path}: a password for ${m[1]}`);
  for (const m of text.matchAll(/[A-Za-z0-9_-]{32,}/g))
    if (m[0] !== TEST_SECRET && !/^[0-]+$/.test(m[0]))
      found.push(`${path}: ${m[0].slice(0, 8)}… looks like a token`);
  return found;
}

describe("the init templates (spec 19, the one-source rule)", () => {
  it("holds dist/templates.json equal to a fresh render of the examples", () => {
    for (const stack of STACKS)
      expect(templates[stack], stack).toEqual(renderStack(stack, REPO, VERSION));
  });

  it("gives each stack the example's files, the base config, and the three files of the stack", () => {
    for (const stack of STACKS) {
      const example = exampleFiles(join(REPO, "examples", STACK_INFO[stack].example));
      const extras = extraFiles(stack).map((f) => f.path);
      expect(templates[stack].map((f) => f.path)).toEqual(
        [...example, "tsconfig.base.json", ...extras].sort(),
      );
      expect(extras.sort()).toEqual([".gitignore", "README.md", STACK_INFO[stack].secrets].sort());
    }
  });

  it("changes no byte of an example but the declared rewrites", () => {
    const pinned = (deps: Record<string, string> | undefined) =>
      deps &&
      Object.fromEntries(
        Object.entries(deps).map(([k, v]) => [k, v === "workspace:*" ? VERSION : v]),
      );
    for (const stack of STACKS) {
      const dir = join(REPO, "examples", STACK_INFO[stack].example);
      for (const path of exampleFiles(dir)) {
        const original = readFileSync(join(dir, path), "utf8");
        const out = rewrite(stack, path, original, VERSION);
        if (path === "package.json") {
          const pkg = JSON.parse(original) as {
            scripts: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          expect(JSON.parse(out), `${stack} ${path}`).toEqual({
            ...pkg,
            name: "my-app",
            ...(pkg.dependencies ? { dependencies: pinned(pkg.dependencies) } : {}),
            ...(pkg.devDependencies ? { devDependencies: pinned(pkg.devDependencies) } : {}),
            scripts: {
              ...pkg.scripts,
              ...(stack === "workers-d1" ? { test: "vitest run" } : {}),
              ...(stack === "bun" ? { start: "bun src/main.ts" } : {}),
            },
          });
        } else if (/^tsconfig[^/]*\.json$/.test(path))
          expect(out, `${stack} ${path}`).toBe(
            original.replace(
              '"extends": "../../tsconfig.base.json"',
              '"extends": "./tsconfig.base.json"',
            ),
          );
        else expect(out, `${stack} ${path}`).toBe(original);
      }
    }
  });

  it("writes no secret into any file", () => {
    const found = STACKS.flatMap((stack) =>
      templates[stack].flatMap((f) => secretsIn(`${stack}/${f.path}`, f.text)),
    );
    expect(found).toEqual([]);
    expect(secretsIn("probe", "AUTH_SECRET=abc")).toHaveLength(1);
    expect(secretsIn("probe", "postgres://u:p@db.example.com/x")).toHaveLength(1);
    expect(secretsIn("probe", "tk_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toHaveLength(1);
  });
});

describe("the dot files of an example", () => {
  it("stops the render at a dot file off the allowlist, such as a .dev.vars or a .DS_Store", () => {
    const dir = fresh("dot-files");
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const f of [
      "package.json",
      "src/index.ts",
      ".gitignore",
      ".dev.vars.example",
      ".env.example",
    ])
      writeFileSync(join(dir, f), "x\n");
    expect(exampleFiles(dir)).toEqual([
      ".dev.vars.example",
      ".env.example",
      ".gitignore",
      "package.json",
      "src/index.ts",
    ]);
    writeFileSync(join(dir, ".dev.vars"), "AUTH_SECRET=x\n");
    expect(() => exampleFiles(dir)).toThrow(`${join(dir, ".dev.vars")}: no template may hold`);
    rmSync(join(dir, ".dev.vars"));
    writeFileSync(join(dir, "src", ".DS_Store"), "x");
    expect(() => exampleFiles(dir)).toThrow(
      `${join(dir, "src", ".DS_Store")}: no template may hold`,
    );
  });
});

describe("authtempo init (spec 19)", () => {
  it("writes the files of each stack, and prints each file and the next steps", () => {
    for (const stack of STACKS) {
      const dir = fresh(`init-${stack}`);
      const r = runBin(["init", dir, "--stack", stack]);
      expect(r.status, r.stderr).toBe(0);
      const files = templates[stack];
      expect(linesOf(r.stderr)[0]).toBe(`writing ${files.length} files to ${dir}`);
      expect(
        linesOf(r.stdout)
          .filter((l) => l.startsWith("wrote "))
          .map((l) => l.slice("wrote ".length)),
      ).toEqual(files.map((f) => f.path));
      for (const f of files) expect(readFileSync(join(dir, f.path), "utf8"), f.path).toBe(f.text);
      expect(r.stdout).toContain(`\nNext:\n  cd ${dir}\n  pnpm install\n`);
      expect(linesOf(r.stdout).at(-1)).toBe(
        `Docs: https://authtempo.com/docs/start/${STACK_INFO[stack].page}/`,
      );
      expect(r.stdout).not.toContain(UNPUBLISHED_NOTE);
      expect(linesOf(r.stderr).at(-1)).toBe(
        UNPUBLISHED ? UNPUBLISHED_NOTE : `writing ${files.length} files to ${dir}`,
      );
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme.includes(UNPUBLISHED_NOTE)).toBe(UNPUBLISHED);
    }
  });

  it("names the install note only while the CLI is unpublished", () => {
    expect(UNPUBLISHED).toBe(PKG_JSON.private === true || PKG_JSON.version === "0.0.0");
  });

  it("quotes a folder with a space or a character of the shell in the cd step", () => {
    const dir = fresh("init a b");
    const r = runBin(["init", dir, "--stack", "node"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`\nNext:\n  cd '${dir}'\n  pnpm install\n`);
    const odd = fresh("init-it's");
    const j = runBin(["init", odd, "--stack", "node", "--json"]);
    expect(j.status, j.stderr).toBe(0);
    expect((JSON.parse(j.stdout) as { next: string[] }).next[0]).toBe(
      `cd '${odd.replace("'", "'\\''")}'`,
    );
  });

  it("prints one JSON document with --json", () => {
    const dir = fresh("init-json");
    const r = runBin(["init", dir, "--stack", "node", "--json"]);
    expect(r.status).toBe(0);
    expect(linesOf(r.stdout)).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as { files: string[]; next: string[] } & Record<
      string,
      unknown
    >;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(INIT_JSON_KEYS).sort());
    expect(doc).toMatchObject({ stack: "node", dir });
    expect(doc.files).toEqual(templates.node.map((f) => f.path));
    expect(doc.next.slice(0, 2)).toEqual([`cd ${dir}`, "pnpm install"]);
  });

  it("writes nothing into a folder that holds one of its files", () => {
    const dir = fresh("init-taken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "name": "other" }\n');
    const r = runBin(["init", dir, "--stack", "workers-d1"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)).toContain(`exists: ${join(dir, "package.json")}`);
    expect(linesOf(r.stderr).at(-1)).toBe(
      `stopped: init writes no file over a file; the folder ${dir} holds 1 of its files`,
    );
    expect(readdirSync(dir)).toEqual(["package.json"]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe('{ "name": "other" }\n');

    const again = fresh("init-again");
    expect(runBin(["init", again, "--stack", "node"]).status).toBe(0);
    rmSync(join(again, "README.md"));
    expect(runBin(["init", again, "--stack", "node"]).status).toBe(2);
    expect(existsSync(join(again, "README.md"))).toBe(false);
  });

  it("needs a stack, and names the near stack of a typo", () => {
    const none = runBin(["init", fresh("init-none")]);
    expect(none.status).toBe(2);
    expect(linesOf(none.stderr)[0]).toBe(
      "name a stack: --stack workers-d1, workers-postgres, node, or bun",
    );
    const typo = runBin(["init", fresh("init-typo"), "--stack", "worker-d1"]);
    expect(typo.status).toBe(2);
    expect(linesOf(typo.stderr)[0]).toBe(
      "--stack is one of workers-d1, workers-postgres, node, bun. Did you mean workers-d1?",
    );
  });
});
