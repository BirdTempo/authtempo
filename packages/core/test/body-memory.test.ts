import { describe, expect, it } from "vitest";
import { bodyCapOf } from "../src/http/body-cap.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteKey } from "../src/http/route-list.js";

/**
 * The memory of the full read path (ruling 46 of the 12j lane, item d). For
 * each distinct route cap, a child Node process with a heap of 128 MB (the
 * memory of a Workers isolate) reads the worst shapes at that cap: the read,
 * the shape scan, the parse, the text walk, and zod. A fatal out-of-memory
 * stops a child with no answer, so each child must answer.
 *
 * The child imports the build of core, so the first test fails when a
 * source file is newer than its build. A turbo run of `test` builds first.
 */

/**
 * The Node calls of this test. Core's typecheck has no Node types, because
 * core runs on Workers; vitest runs in Node. A specifier in a constant keeps
 * each import out of the typecheck (as access.test.ts does).
 */
interface NodeCalls {
  execFile(
    file: string,
    args: string[],
    options: { maxBuffer: number },
    done: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
  readdirSync(
    dir: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  statSync(path: string): { mtimeMs: number };
}
const CHILD_PROCESS_MODULE = "node:child_process";
const FS_MODULE = "node:fs";
const node = async (): Promise<NodeCalls> => ({
  ...(await import(/* @vite-ignore */ CHILD_PROCESS_MODULE)),
  ...(await import(/* @vite-ignore */ FS_MODULE)),
});
/** The path of the Node program that runs vitest. */
const NODE = (globalThis as unknown as { process: { execPath: string } }).process.execPath;

const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const CHILD = pathOf("./fixtures/body-memory-child.mjs");
const SRC = pathOf("../src/");
const DIST = pathOf("../dist/");
const HEAP_MB = 128;
const SHAPES = [
  "zeros",
  "zeros-at-limit",
  "nesting",
  "nesting-at-limit",
  "string",
  "keys",
  "keys-at-limit",
];

interface ChildLine {
  route: string;
  shape: string;
  cap: number;
  bytes: number;
  answer: string;
  peakHeapMB: number;
  readRssMB: number;
}

/** The answer line of one child, or the end of a child that gave none. */
async function runChild(args: string[]): Promise<ChildLine> {
  const { execFile } = await node();
  return new Promise((resolve, reject) => {
    execFile(
      NODE,
      [`--max-old-space-size=${HEAP_MB}`, "--expose-gc", CHILD, ...args],
      { maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const line = stdout.split("\n").find((l) => l.startsWith("{"));
        if (error || line === undefined)
          return reject(
            new Error(
              `${args.join(" ")}: no answer (${error?.message ?? "exit 0"}) ${stderr.slice(0, 400)}`,
            ),
          );
        resolve(JSON.parse(line) as ChildLine);
      },
    );
  });
}

/** Runs `jobs` with at most `width` at a time, so a loaded machine is not swamped. */
async function inBatches<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < jobs.length; i += width)
    out.push(...(await Promise.all(jobs.slice(i, i + width).map((job) => job()))));
  return out;
}

/** Each source file of core with the time of its last change. */
function sources(fs: NodeCalls, dir: string): { file: string; mtime: number }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sources(fs, `${path}/`);
    return entry.name.endsWith(".ts") ? [{ file: path, mtime: fs.statSync(path).mtimeMs }] : [];
  });
}

describe("the memory of the body read path (ruling 46 of the 12j lane)", () => {
  it("reads the build of core that is newer than each source file", async () => {
    const fs = await node();
    const stale = sources(fs, SRC).filter(({ file, mtime }) => {
      const built = `${DIST}${file.slice(SRC.length).replace(/\.ts$/, ".js")}`;
      try {
        return fs.statSync(built).mtimeMs < mtime;
      } catch {
        return true;
      }
    });
    expect(stale.map((s) => s.file.slice(SRC.length))).toEqual([]);
  });

  it("answers the worst shapes at each distinct route cap in a heap of 128 MB", {
    timeout: 120_000,
  }, async () => {
    // One route of each cap: the route with the largest cap, then the first of each other cap.
    const byCap = new Map<number, RouteKey>();
    for (const [key, contract] of Object.entries(ROUTE_CONTRACT) as [
      RouteKey,
      { body?: unknown },
    ][])
      if (contract.body !== undefined && !byCap.has(bodyCapOf(key))) byCap.set(bodyCapOf(key), key);
    expect([...byCap.keys()].sort((a, b) => a - b)).toEqual([65_536, 262_144, 8_388_608]);
    const lines = await inBatches(
      [...byCap.values()].flatMap((route) => SHAPES.map((shape) => () => runChild([route, shape]))),
      4,
    );
    console.log(
      lines
        .map(
          (l) =>
            `body-memory: cap=${l.cap} shape=${l.shape} bytes=${l.bytes} answer=${l.answer} peakHeapMB=${l.peakHeapMB} readRssMB=${l.readRssMB}`,
        )
        .join("\n"),
    );
    expect(lines).toHaveLength(byCap.size * SHAPES.length);
    for (const l of lines) {
      // Each body fills its cap: no shape is smaller than the cap less one unit of it.
      expect(l.bytes).toBeGreaterThan(l.cap - 32);
      expect(l.bytes).toBeLessThanOrEqual(l.cap);
      expect(l.peakHeapMB).toBeLessThan(HEAP_MB);
    }
  });

  it("walks a parsed array of 4 million zeros for bad text in a heap of 128 MB", {
    timeout: 60_000,
  }, async () => {
    const line = await runChild(["POST /sso/connections/update", "zeros", "walk"]);
    expect(line).toMatchObject({ cap: 8_388_608, answer: "clean" });
    expect(line.peakHeapMB).toBeLessThan(HEAP_MB);
  });
});
