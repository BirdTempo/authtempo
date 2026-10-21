import { describe, expect, it } from "vitest";
import { LIMIT_FAMILIES } from "../src/limiter/limit.js";

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

const SRC = new URL("../src/", import.meta.url);
/** The one caller of the limiter port (spec 31 item 10). */
const HELPER = "limiter/limit.ts";
/** The conformance suite calls the port of an adapter, and the memory limiter is an adapter. */
const ALLOWED = new Set([HELPER, "limiter/conformance.ts", "limiter/memory.ts"]);

/** Every file under `src`, by its path from `src`. */
function walk(fs: WalkFs, dir: URL, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(fs, new URL(`${entry.name}/`, dir), `${path}/`));
    else out.push(path);
  }
  return out;
}

async function sources(): Promise<{ file: string; text: string }[]> {
  const fs: WalkFs = await import(/* @vite-ignore */ FS_MODULE);
  return walk(fs, SRC).map((file) => ({ file, text: fs.readFileSync(new URL(file, SRC), "utf8") }));
}

describe("the limiter families (plan 12h Task 7)", () => {
  it("calls the limiter only in the helper", async () => {
    const files = await sources();
    expect(files.map((f) => f.file)).toContain(HELPER);
    expect(files.map((f) => f.file)).toContain("engine/magic-link.ts");
    // A call, a call through call, bind, or apply, and a computed member.
    const holders = files
      .filter(({ file }) => !ALLOWED.has(file))
      .filter(({ text }) => /\.allow\s*[(.]|\[\s*["'`]allow["'`]\s*\]/.test(text))
      .map(({ file }) => file);
    expect(holders).toEqual([]);
  });

  it("lists each family once", () => {
    expect(LIMIT_FAMILIES.length).toBeGreaterThan(0);
    expect(new Set(LIMIT_FAMILIES).size).toBe(LIMIT_FAMILIES.length);
    for (const family of LIMIT_FAMILIES) expect(family).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
  });

  it("gives each family a call site", async () => {
    // A family with no call site would put a limit on the limits page that core never counts.
    const others = (await sources()).filter(({ file }) => file !== HELPER);
    const unused = LIMIT_FAMILIES.filter(
      (family) => !others.some(({ text }) => text.includes(`"${family}"`)),
    );
    expect(unused).toEqual([]);
  });
});
