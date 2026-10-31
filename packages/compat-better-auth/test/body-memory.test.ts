import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The memory of the large body reads through the shim (ruling 68 Minor 1 of
 * the 12j lane), with the bound of core's body-memory.test.ts. A child Node
 * process with a heap of 128 MB (the memory of a Workers isolate) sends
 * reads at once to the handler of the shim: 30 SSO connection writes of 8
 * MiB of 30 users, 30 registers of 8 MiB, and 16 SAML forms of 16 IPs.
 * Before the ruling, the shim cloned every POST and read the clone of an
 * SSO write, then core read the request. A clone is a tee, so a large body
 * was held twice while the budget counted it once.
 *
 * The child imports the build of the shim and of core, so the first test
 * fails when a source file of the shim is newer than its build. A turbo run
 * of `test` builds first.
 */

const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const CHILD = pathOf("./fixtures/body-memory-child.mjs");
const SRC = pathOf("../src/");
const DIST = pathOf("../dist/");
const HEAP_MB = 128;

interface ChildLine {
  path: string;
  reads: number;
  live: boolean;
  answers: string[];
  ms: number;
  baseHeapMB: number;
  baseArrayBuffersMB: number;
  peakHeapMB: number;
  peakArrayBuffersMB: number;
  peakHeapPlusArrayBuffersMB: number;
  /** The SAML forms of `SAML_FORM_MAX` that the anonymous half holds, by the build of core. */
  anonForms: number;
}

/** The answer line of one child, or the end of a child that gave none. */
function runChild(args: string[]): Promise<ChildLine> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
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

/** Each source file of the shim with the time of its last change. */
function sources(dir: string): { file: string; mtime: number }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sources(`${path}/`);
    return entry.name.endsWith(".ts") ? [{ file: path, mtime: statSync(path).mtimeMs }] : [];
  });
}

/** The count of each answer: "503 SERVICE_UNAVAILABLE" to its count. */
const counted = (answers: string[]) =>
  Object.fromEntries([...new Set(answers)].map((a) => [a, answers.filter((b) => b === a).length]));

describe("the memory of the large reads through the shim (ruling 68 Minor 1 of the 12j lane)", () => {
  it("reads the build of the shim that is newer than each source file", () => {
    const stale = sources(SRC).filter(({ file, mtime }) => {
      const built = `${DIST}${file.slice(SRC.length).replace(/\.tsx?$/, ".js")}`;
      try {
        return statSync(built).mtimeMs < mtime;
      } catch {
        return true;
      }
    });
    expect(stale.map((s) => s.file.slice(SRC.length))).toEqual([]);
  });

  it("holds the SSO writes, the registers, and the ACS forms at once under 128 MB", {
    timeout: 120_000,
  }, async () => {
    const runs = [
      ["sso", "30"],
      ["sso", "30", "live"],
      ["register", "30"],
      ["register", "30", "live"],
      ["acs", "16"],
      ["acs", "16", "live"],
    ];
    const lines: ChildLine[] = [];
    // One child at a time: each child measures its own peak, and a loaded machine is not swamped.
    for (const args of runs) lines.push(await runChild(args));
    console.log(
      lines
        .map(
          (l) =>
            `body-memory: shim ${l.path} reads=${l.reads} live=${l.live} answers=${JSON.stringify(counted(l.answers))} ms=${l.ms} baseMB=${l.baseHeapMB + l.baseArrayBuffersMB} peakHeapMB=${l.peakHeapMB} peakArrayBuffersMB=${l.peakArrayBuffersMB} peakHeapPlusArrayBuffersMB=${l.peakHeapPlusArrayBuffersMB}`,
        )
        .join("\n"),
    );
    for (const l of lines) {
      // The user half answers one write of the cap. Each other write answers 503 at once.
      if (l.path === "sso")
        expect(counted(l.answers)).toEqual({
          "400 invalid_body": 1,
          "503 SERVICE_UNAVAILABLE": l.reads - 1,
        });
      if (l.path === "register")
        expect(counted(l.answers)).toEqual({
          "501 NOT_SUPPORTED": 1,
          "503 SERVICE_UNAVAILABLE": l.reads - 1,
        });
      // The anonymous half holds 7 forms of 7 IPs. Each other form answers 503 at once.
      if (l.path === "acs")
        expect(counted(l.answers)).toEqual({
          "302 sso_failed": l.anonForms,
          "503 body_busy": l.reads - l.anonForms,
        });
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
