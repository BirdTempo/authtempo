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

const SRC = new URL("../src/", import.meta.url);
/** The one file of core that calls console (spec 31 item 2). */
const DEFAULT_OUTPUT = "observe/default-output.ts";

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

describe("console in core (plan 12h Task 3)", () => {
  it("calls console only in the default output", async () => {
    const fs: WalkFs = await import(/* @vite-ignore */ FS_MODULE);
    const files = walk(fs, SRC);
    expect(files).toContain(DEFAULT_OUTPUT);
    // Read as text, comments too: a comment that names console. misleads the next reader.
    // The console[ form is a call too, as in the default output itself.
    const holders = files.filter((f) => {
      if (f === DEFAULT_OUTPUT) return false;
      const text = fs.readFileSync(new URL(f, SRC), "utf8");
      return text.includes("console.") || text.includes("console[");
    });
    expect(holders).toEqual([]);
  });
});
