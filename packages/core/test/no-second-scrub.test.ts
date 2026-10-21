import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls of the walk. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface WalkFs {
  readdirSync(
    dir: URL,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

const ROOT = new URL("../../../", import.meta.url);
/** The one file that may hold the scrub and the control filter. */
const SOURCE = "packages/core/src/redact.ts";
/** A folder of these names holds tests or build output, not a log path of a product. */
const SKIP = new Set(["node_modules", "dist", "test", "tests", "__tests__"]);

/** A source file of these extensions can hold a log path. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro)$/;
/** The folders of the walk: each package, app, example, and root script. */
const TOPS = ["packages/", "apps/", "examples/", "scripts/"];

/**
 * A file that holds one scrub declaration for another job, with the reason.
 * The test drops only the named finding: a second finding in the file fails.
 */
const EXEMPT: readonly { file: string; holds: string; reason: string }[] = [
  {
    file: "examples/electron/proof/run.mjs",
    holds: "const scrub",
    reason:
      "a proof script masks hc_ handoff codes in its own failure text; it is not a log path of a product",
  },
];

/**
 * A scrub declaration in each form: a function, or a const, let, or var,
 * with a type or an export before it or not.
 */
const SCRUB_DECLARATION = /\b(?:function\s+scrub\s*\(|(?:const|let|var)\s+scrub\b)/g;
/** A regular expression literal with its flags. */
const REGEX_LITERAL = /\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/g;

/**
 * A second scrub, or a second control filter: a regular expression literal
 * with the `g` flag that holds `\u0000` and `\u001f`. The rule reads the `\u`
 * spelling only. A filter in the `\x` spelling, such as the path encoder of
 * tanstack-start, is not a redaction of secrets, and the rule does not see it.
 */
function findings(text: string): string[] {
  const found: string[] = [];
  for (const [declaration] of text.matchAll(SCRUB_DECLARATION))
    found.push(declaration.replace(/\s+/g, " ").replace(/ \($/, "("));
  for (const [literal] of text.matchAll(REGEX_LITERAL)) {
    const flags = literal.slice(literal.lastIndexOf("/") + 1);
    if (flags.includes("g") && literal.includes("\\u0000") && literal.includes("\\u001f"))
      found.push(literal);
  }
  return found;
}

async function walk(): Promise<{ fs: WalkFs; files: string[] }> {
  const fs: WalkFs = await import(/* @vite-ignore */ FS_MODULE);
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      // A dot folder holds the output of a tool (.wrangler, .astro, .turbo).
      if (entry.name.startsWith(".")) continue;
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) visit(`${path}/`);
      } else if (SOURCE_FILE.test(entry.name)) files.push(path);
    }
  };
  for (const top of TOPS) visit(top);
  return { fs, files };
}

describe("the one redaction source (plan 12h Task 1, spec 31 item 9)", () => {
  it("has one scrub and one control filter in the repo", async () => {
    const { fs, files } = await walk();
    const found = files
      .filter((file) => file !== SOURCE)
      .flatMap((file) => {
        const own = findings(fs.readFileSync(new URL(file, ROOT), "utf8"));
        // An exempt file loses its one named finding, and keeps each other finding.
        const named = EXEMPT.find((e) => e.file === file)?.holds;
        const at = named === undefined ? -1 : own.indexOf(named);
        if (at >= 0) own.splice(at, 1);
        return own.map((what) => `${file}: ${what}`);
      });
    expect(found).toEqual([]);
    // The walk must read the source: a walk that finds no file finds no second scrub.
    expect(files).toContain(SOURCE);
  });

  it("names an exempt file only while the file still holds its own scrub", async () => {
    const { fs, files } = await walk();
    for (const e of EXEMPT) {
      expect(files, e.file).toContain(e.file);
      expect(findings(fs.readFileSync(new URL(e.file, ROOT), "utf8")), e.file).toContain(e.holds);
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});
