import { describe, expect, it } from "vitest";
import {
  bodyCapOf,
  LARGE_READ_ANON_BUDGET,
  LARGE_READ_BUDGET,
  LARGE_READ_SHARE,
} from "../src/http/body-cap.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteKey } from "../src/http/route-list.js";

/**
 * The memory of the full read path (ruling 46 of the 12j lane, item d). For
 * each distinct route cap, a child Node process with a heap of 128 MB (the
 * memory of a Workers isolate) reads the worst shapes at that cap: the read,
 * the shape scan, the parse, the text walk, and zod. A fatal out-of-memory
 * stops a child with no answer, so each child must answer. The SAML ACS
 * form at `SAML_FORM_MAX` and the SCIM body at `SCIM_BODY_MAX` join it with
 * their own worst shapes (ruling 51), the SCIM body also at its scan limits
 * (ruling 56). Each child records the peak of its heap and of its array
 * buffers.
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
/** The SAML ACS: its form at `SAML_FORM_MAX`, through createAuth with no sign-in. */
const ACS = "POST /sso/:connectionId/acs";
const FORM_SHAPES = [
  "form-keys",
  "form-empty",
  "form-escapes",
  "form-pairs",
  "form-plus",
  "form-value",
  "form-at-limit",
];
/**
 * The heap bound of the ACS form of one key of "+" (ruling 59 Low 2 of the
 * 12j lane). Node's URLSearchParams turns each "+" into a space. At
 * `SAML_FORM_MAX` that form peaked at 60 MB in five runs (2026-10-30, Node
 * 26.10.0, load 42), and at 59 MB in the re-review. Each other form shape
 * peaks at 27 to 28 MB. The bound is that peak and a third more, so a
 * parse that grows fails here, and 48 MB of the isolate stay for the other
 * requests.
 */
const FORM_PLUS_HEAP_MB = 80;
/** A SCIM write: its body at `SCIM_BODY_MAX`, through readScimBody and its shape scan. */
const SCIM = "POST /scim/v2/Users";
/** The SCIM shapes past the depth or the item limit: each answers 400 before the parse. */
const SCIM_PAST = ["nesting", "zeros", "empties", "objects", "keys"];
const SCIM_SHAPES = [
  ...SCIM_PAST,
  "string",
  "zeros-at-limit",
  "objects-at-limit",
  "nesting-at-limit",
  "keys-at-limit",
];

/** The line of a child that runs reads of `REQUEST_BODY_MAX` at once. */
interface BudgetLine {
  live: boolean;
  reads: number;
  answers: string[];
  ms: number;
  baseHeapMB: number;
  baseArrayBuffersMB: number;
  peakHeapMB: number;
  peakArrayBuffersMB: number;
  peakHeapPlusArrayBuffersMB: number;
}

interface ChildLine {
  route: string;
  shape: string;
  cap: number;
  bytes: number;
  answer: string;
  ms: number;
  peakHeapMB: number;
  peakArrayBuffersMB: number;
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
    const jobs: [string, string][] = [
      ...[...byCap.values()].flatMap((route) =>
        SHAPES.map((shape): [string, string] => [route, shape]),
      ),
      ...FORM_SHAPES.map((shape): [string, string] => [ACS, shape]),
      ...SCIM_SHAPES.map((shape): [string, string] => [SCIM, shape]),
    ];
    const lines = await inBatches(
      jobs.map((job) => () => runChild(job)),
      4,
    );
    console.log(
      lines
        .map(
          (l) =>
            `body-memory: ${l.route} cap=${l.cap} shape=${l.shape} bytes=${l.bytes} answer=${l.answer} ms=${l.ms} peakHeapMB=${l.peakHeapMB} peakArrayBuffersMB=${l.peakArrayBuffersMB} readRssMB=${l.readRssMB}`,
        )
        .join("\n"),
    );
    expect(lines).toHaveLength(jobs.length);
    for (const l of lines) {
      // Each body fills its cap: no shape is smaller than the cap less one unit of it.
      expect(l.bytes).toBeGreaterThan(l.cap - 32);
      expect(l.bytes).toBeLessThanOrEqual(l.cap);
      expect(l.peakHeapMB).toBeLessThan(HEAP_MB);
    }
    // The ACS refuses each form at the form step, or later for the one long value.
    // Before the pair limit a form of "a&" pairs took 5.2 s; the margin here is wide.
    for (const l of lines.filter((l) => l.route === ACS)) {
      expect([l.shape, l.answer]).toEqual([l.shape, "302 sso_failed"]);
      expect(l.ms).toBeLessThan(1000);
    }
    // SCIM refuses each shape past its limits, and reads one string and each shape at them.
    for (const l of lines.filter((l) => l.route === SCIM))
      expect([l.shape, l.answer]).toEqual([l.shape, SCIM_PAST.includes(l.shape) ? "400" : "ok"]);
    const plus = lines.find((l) => l.route === ACS && l.shape === "form-plus");
    expect(plus?.peakHeapMB).toBeLessThan(FORM_PLUS_HEAP_MB);
  });

  it("walks a parsed array of 4 million zeros for bad text in a heap of 128 MB", {
    timeout: 60_000,
  }, async () => {
    const line = await runChild(["POST /sso/connections/update", "zeros", "walk"]);
    expect(line).toMatchObject({ cap: 8_388_608, answer: "clean" });
    expect(line.peakHeapMB).toBeLessThan(HEAP_MB);
  });

  it("runs the budget's large reads at once and one more, and a burst, under 128 MB", {
    timeout: 60_000,
  }, async () => {
    // The budget's reads: one user read of the cap, and the shares of 2 IPs (ruling 69).
    const ips = LARGE_READ_ANON_BUDGET / LARGE_READ_SHARE;
    const count = 1 + ips;
    const { execFile } = await node();
    const budget = (args: string[]) =>
      new Promise<BudgetLine>((resolve, reject) =>
        execFile(
          NODE,
          [`--max-old-space-size=${HEAP_MB}`, "--expose-gc", CHILD, "budget", ...args],
          { maxBuffer: 1 << 20 },
          (error, stdout, stderr) => {
            const line = stdout.split("\n").find((l) => l.startsWith("{"));
            if (error || line === undefined)
              return reject(
                new Error(`budget ${args.join(" ")}: no answer ${stderr.slice(0, 400)}`),
              );
            resolve(JSON.parse(line) as BudgetLine);
          },
        ),
      );
    const lines = await inBatches(
      [[String(count + 1)], [String(count + 1), "live"], ["30"], ["30", "live"]].map(
        (args) => () => budget(args),
      ),
      2,
    );
    console.log(
      lines
        .map(
          (l) =>
            `body-memory: budget=${LARGE_READ_BUDGET} reads=${l.reads} live=${l.live} busy=${l.answers.filter((a) => a.endsWith(" BodyBusy")).length} ms=${l.ms} baseMB=${l.baseHeapMB + l.baseArrayBuffersMB} peakHeapMB=${l.peakHeapMB} peakArrayBuffersMB=${l.peakArrayBuffersMB} peakHeapPlusArrayBuffersMB=${l.peakHeapPlusArrayBuffersMB}`,
        )
        .join("\n"),
    );
    for (const l of lines) {
      // The user half answers one read of the cap, and the anonymous half the shares of 2 IPs.
      // Each other read answers BodyBusy at once (rulings 66 and 69).
      expect(l.answers.filter((a) => !a.endsWith(" BodyBusy"))).toEqual([
        ...Array(ips).fill("ip invalid_body"),
        "user invalid_body",
      ]);
      // Heap and array buffers together, garbage included, stay within the isolate.
      expect(l.peakHeapPlusArrayBuffersMB).toBeLessThan(HEAP_MB);
      // The live growth over the base, with no garbage, stays within half of it.
      if (l.live)
        expect(l.peakHeapPlusArrayBuffersMB - l.baseHeapMB - l.baseArrayBuffersMB).toBeLessThan(
          HEAP_MB / 2,
        );
    }
  });
});
