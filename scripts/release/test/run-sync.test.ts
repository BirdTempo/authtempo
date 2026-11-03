import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_TIMEOUT_MS,
  REGISTRY_TIMEOUT_MS,
  RunTimeout,
  runSync,
  STEP_TIMEOUT_MS,
} from "../src/lib/run-sync.ts";

const SRC = new URL("../src/", import.meta.url);
const source = (file: string) => readFileSync(new URL(file, SRC), "utf8");

/** The count of sync child process calls in `text`. */
const syncSpawns = (text: string) =>
  [...text.matchAll(/\b(?:spawnSync|execFileSync|execSync)\(/g)].length;

/** The thrown error of `fn`, or null when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("runSync", () => {
  it("ends a call that ignores SIGTERM at its limit, names the call, and leaves no process", () => {
    const dir = mkdtempSync(join(tmpdir(), "authtempo-run-sync-"));
    try {
      const pidFile = join(dir, "pid");
      // exec keeps the pid of sh, and sleep keeps the ignored SIGTERM.
      const script = `echo $$ > "$0"; trap '' TERM; exec sleep 30`;
      const start = Date.now();
      const error = thrownBy(() => runSync("sh", ["-c", script, pidFile], { timeoutMs: 300 }));
      expect(Date.now() - start).toBeLessThan(10_000);
      expect(error).toBeInstanceOf(RunTimeout);
      expect((error as Error).message).toBe(`sh -c ${script} ${pidFile} did not end in 300 ms`);
      // spawnSync waits for the child after SIGKILL, so its pid names no process.
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      expect((thrownBy(() => process.kill(pid, 0)) as NodeJS.ErrnoException).code).toBe("ESRCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers the status and the output of a call that ends", () => {
    const r = runSync("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 60_000 });
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error }).toEqual({
      status: 3,
      stdout: "out\n",
      stderr: "err\n",
      error: undefined,
    });
  });

  it("holds the limits of plan 12n", () => {
    expect([GIT_TIMEOUT_MS, REGISTRY_TIMEOUT_MS, STEP_TIMEOUT_MS]).toEqual([
      60_000, 120_000, 1_200_000,
    ]);
  });

  it("is the one sync child process call of src, apart from tar of check-pack.ts", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThan(20);
    const others = files.filter(
      (f) => f !== "lib/run-sync.ts" && f !== "check-pack.ts" && syncSpawns(source(f)) > 0,
    );
    expect(others).toEqual([]);
    expect(syncSpawns(source("lib/run-sync.ts"))).toBe(1);
    expect(syncSpawns(source("check-pack.ts"))).toBe(1);
    // The fault form, so the fact can fail.
    expect(syncSpawns('const r = spawnSync("git", ["status"]);')).toBe(1);
  });

  it("gives each call site the limit of its kind", () => {
    const limits = (file: string) =>
      [...source(file).matchAll(/timeoutMs: (\w+)/g)].map((m) => m[1]).sort();
    expect(limits("lib/git.ts")).toEqual(["GIT_TIMEOUT_MS"]);
    expect(limits("check-tag.ts")).toEqual(["GIT_TIMEOUT_MS"]);
    expect(limits("check-changesets.ts")).toEqual(["REGISTRY_TIMEOUT_MS"]);
    expect(limits("dry-run.ts")).toEqual(["STEP_TIMEOUT_MS"]);
    expect(limits("publish.ts")).toEqual(["REGISTRY_TIMEOUT_MS", "STEP_TIMEOUT_MS"]);
  });
});
