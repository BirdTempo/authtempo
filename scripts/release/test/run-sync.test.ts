import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_TIMEOUT_MS,
  limitOf,
  REGISTRY_TIMEOUT_MS,
  RunTimeout,
  runSync,
  STEP_TIMEOUT_MS,
  setLimitForTest,
} from "../src/lib/run-sync.ts";
import { OUTPUT_STALL_MS, STALL_MS, withLimit } from "./support/stall.ts";

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
      // The test reads the pid file, which the shell writes before the kill.
      const error = withLimit("step", OUTPUT_STALL_MS, () =>
        thrownBy(() => runSync("sh", ["-c", script, pidFile], { limit: "step" })),
      );
      expect(Date.now() - start).toBeLessThan(10_000);
      expect(error).toBeInstanceOf(RunTimeout);
      expect((error as Error).message).toBe(
        `sh -c ${script} ${pidFile} did not end in ${OUTPUT_STALL_MS} ms`,
      );
      // spawnSync waits for the child after SIGKILL, so its pid names no process.
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      expect((thrownBy(() => process.kill(pid, 0)) as NodeJS.ErrnoException).code).toBe("ESRCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the output of a call up to the kill (review of Task 1 of plan 12n, M2)", () => {
    const error = withLimit("step", OUTPUT_STALL_MS, () =>
      thrownBy(() =>
        runSync("sh", ["-c", "echo out; echo err >&2; exec sleep 30"], { limit: "step" }),
      ),
    );
    expect(error).toBeInstanceOf(RunTimeout);
    expect({ stdout: (error as RunTimeout).stdout, stderr: (error as RunTimeout).stderr }).toEqual({
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("answers the status and the output of a call that ends", () => {
    const r = runSync("sh", ["-c", "echo out; echo err >&2; exit 3"], { limit: "step" });
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
    // Each kind reads its own limit, and the setter of a test restores it.
    expect([limitOf("git"), limitOf("registry"), limitOf("step")]).toEqual([
      GIT_TIMEOUT_MS,
      REGISTRY_TIMEOUT_MS,
      STEP_TIMEOUT_MS,
    ]);
    const restore = setLimitForTest("git", STALL_MS);
    expect(limitOf("git")).toBe(STALL_MS);
    restore();
    expect(limitOf("git")).toBe(GIT_TIMEOUT_MS);
  });

  it("lets only a test set a limit (review of Task 1 of plan 12n, L1)", () => {
    const setters = (text: string) => [...text.matchAll(/\bsetLimitForTest\b/g)].length;
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => f !== "lib/run-sync.ts" && setters(source(f)) > 0)).toEqual([]);
    // The definition is the one name in run-sync.ts. The fault form, so the fact can fail.
    expect(setters(source("lib/run-sync.ts"))).toBe(1);
    expect(setters('setLimitForTest("git", 1);')).toBe(1);
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
      [...source(file).matchAll(/\blimit: "(\w+)"/g)].map((m) => m[1]).sort();
    expect(limits("lib/git.ts")).toEqual(["git"]);
    expect(limits("check-tag.ts")).toEqual(["git"]);
    expect(limits("check-changesets.ts")).toEqual(["registry"]);
    expect(limits("dry-run.ts")).toEqual(["step"]);
    expect(limits("publish.ts")).toEqual(["registry", "step"]);
  });
});
