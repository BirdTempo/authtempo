import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extraFiles, STACKS, UNPUBLISHED, UNPUBLISHED_NOTE } from "../src/templates.js";
import { assertFreshBuild, linesOf, PKG, REPO } from "./support/bin.js";

/**
 * The run form that the docs give while the packages are unpublished (plan
 * 11c final review, M1). The reader runs it in the folder of the app, so a
 * test that runs it from the package folder would prove nothing: each run
 * here starts in a new temporary folder outside the repo.
 */
const PLACEHOLDER = "/path/to/authtempo";
const DOCS = join(REPO, "apps/site/src/content/docs/docs");
const INDEX = join(DOCS, "reference/cli/index.md");

/** The pages that give the run note, each with the same node form. */
const PAGES = [
  "reference/cli/init.md",
  "reference/cli/migrate.md",
  "reference/cli/check.md",
  "reference/cli/keys.md",
  "reference/cli/import.md",
  "operations/upgrades.md",
  "migrate/supabase.mdx",
  "migrate/clerk.mdx",
  "migrate/auth0.mdx",
  "migrate/firebase.mdx",
  "migrate/authjs.mdx",
  "migrate/cognito.mdx",
  "migrate/workos.mdx",
  "migrate/better-auth.mdx",
];

/** The `node <path>` line of the sh fence of "Run it from this repo" on the CLI index page. */
function documentedForm(): { line: string; bin: string } {
  const page = readFileSync(INDEX, "utf8");
  const section = page.split("## Run it from this repo")[1]?.split("\n## ")[0] ?? "";
  const fence = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  const line = fence.split("\n").find((l) => l.startsWith("node ")) ?? "";
  const m = /^node (\S+) --help$/.exec(line);
  if (!m?.[1]?.startsWith(`${PLACEHOLDER}/`))
    throw new Error(`${INDEX}: the run section has no line "node ${PLACEHOLDER}/… --help"`);
  return { line, bin: m[1] };
}

/** The README of this package, by its name in a fault line. */
const README = "packages/cli/README.md";

/** The texts that give the run note: each page of PAGES, and the README. */
function noteTexts(): Map<string, string> {
  const texts = new Map(PAGES.map((p) => [p, readFileSync(join(DOCS, p), "utf8")] as const));
  return texts.set(README, readFileSync(join(PKG, "README.md"), "utf8"));
}

/**
 * The faults of the run note at a version of the CLI (ruling 58 of plan 12j,
 * item 2). At 0.0.0, each page and the README give the clone form of the
 * index page. At the first release, rewrite-unpublished replaces each note
 * with the registry text. So above 0.0.0, no page and not the README holds
 * the placeholder. The index page keeps its section "Run it from this repo"
 * at every version.
 */
function noteFaults(unpublished: boolean, texts: ReadonlyMap<string, string>): string[] {
  const faults: string[] = [];
  for (const [name, text] of texts) {
    if (!unpublished) {
      if (text.includes(PLACEHOLDER)) faults.push(`${name}: holds ${PLACEHOLDER} above 0.0.0`);
    } else if (name === README) {
      if (!text.includes(form.line)) faults.push(`${name}: lacks the line ${form.line}`);
    } else {
      if (!text.includes(`\`node ${form.bin} …\` in the folder of your app`))
        faults.push(`${name}: lacks the node form at 0.0.0`);
      if (text.includes("exec authtempo …")) faults.push(`${name}: names exec authtempo at 0.0.0`);
    }
  }
  return faults;
}

let tmp: string;
let form: { line: string; bin: string };
/** The documented binary, with the path of this clone in place of the placeholder. */
let bin: string;

/** Runs the documented form in the temporary folder, with a small environment. */
function runDocumented(args: readonly string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: tmp,
    encoding: "utf8",
    input: "",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
    timeout: 120_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeAll(() => {
  assertFreshBuild();
  form = documentedForm();
  bin = join(REPO, form.bin.slice(PLACEHOLDER.length + 1));
  // realpath: on macOS the temporary folder is a link under /private.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-documented-run-")));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("the documented run form", () => {
  it("names the built binary of this package", () => {
    expect(bin).toBe(join(PKG, "dist/bin/authtempo.js"));
    expect(existsSync(bin)).toBe(true);
  });

  it("gives the clone form at 0.0.0 and no placeholder above, in each page note and the README", () => {
    const texts = noteTexts();
    expect(noteFaults(UNPUBLISHED, texts)).toEqual([]);
    // The rule of the other state fails each text of this tree, so each branch can fail.
    const other = noteFaults(!UNPUBLISHED, texts);
    for (const name of texts.keys())
      expect(
        other.some((f) => f.startsWith(`${name}: `)),
        name,
      ).toBe(true);
    // The CLI holds its note at every version and shows it only at 0.0.0.
    expect(UNPUBLISHED_NOTE).toContain(`node ${form.bin} in the folder of the app`);
  });

  // The docs give the node form while the packages are unpublished. A published
  // scaffold runs pnpm exec authtempo, so its README holds no placeholder path.
  it("holds the docs form to the unpublished branch of the scaffold", () => {
    for (const stack of STACKS) {
      const readme = (published: boolean) =>
        extraFiles(stack, published).find((f) => f.path === "README.md")?.text ?? "";
      expect(readme(false), stack).toContain(`node ${form.bin} in the folder of the app`);
      expect(readme(true), stack).not.toContain(PLACEHOLDER);
    }
  });

  it("prints the complete help, as the page shows it", () => {
    const r = runDocumented(["--help"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("authtempo");
  });

  it("writes init into the current folder, not into examples/worker", () => {
    const r = runDocumented(["init", "my-app", "--stack", "node", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(tmp, "my-app", "package.json"))).toBe(true);
    expect(existsSync(join(REPO, "examples/worker/my-app"))).toBe(false);
  });

  it("reads the wrangler config of the current folder", () => {
    const r = runDocumented(["migrate", "--target", "d1", "--dry-run"]);
    expect(r.status, r.stderr).toBe(2);
    expect(linesOf(r.stderr).join("\n")).toContain(tmp);
  });

  it("exits 2 on a usage error", () => {
    const r = runDocumented(["migrate", "--target", "nope"]);
    expect(r.status, r.stderr).toBe(2);
  });

  // The notes say why the pnpm filter form is for --help only. These two
  // runs keep that sentence true: a pnpm that starts to pass exit 2 through,
  // or to run in the folder of the caller, fails here, and the notes change.
  it("keeps the note on the pnpm filter form true", () => {
    const pnpm = (args: readonly string[]) =>
      spawnSync("pnpm", ["--dir", REPO, "--filter", "authtempo-example-worker", "exec", ...args], {
        cwd: tmp,
        encoding: "utf8",
        input: "",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        timeout: 120_000,
      });
    const pwd = pnpm(["pwd"]);
    expect(pwd.status, pwd.stderr).toBe(0);
    expect(pwd.stdout.trim()).toBe(join(REPO, "examples/worker"));
    const usage = pnpm(["authtempo", "migrate", "--target", "nope"]);
    expect(usage.status).toBe(1);
  });
});
