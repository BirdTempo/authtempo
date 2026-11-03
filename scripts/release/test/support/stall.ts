import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type LimitKind, setLimitForTest } from "../../src/lib/run-sync.ts";

/** The limit of a stalled call in a test, in ms. */
export const STALL_MS = 300;

/**
 * The limit of a stall test that reads what its child wrote before the kill,
 * in ms. The kill comes at the limit after the spawn. A slow start of the
 * shell then loses the output, and the test fails with no fault in the code.
 * On 2026-11-03, a probe spawned 1818 such shells, 18 at a time, on one host
 * with 18 cores. It ran during a forced run of the CLI and example tests. The
 * slowest shell wrote its lines 217.4 ms after the spawn, and the 1-minute
 * load peaked at 13.08 (log: .superpowers/tools/logs/probe-12n-fwa-2026-11-03.log).
 * So 300 ms is 1.4 times that measure, and 3000 ms is about 14 times it.
 */
export const OUTPUT_STALL_MS = 3_000;

/** A shell script that never ends. exec keeps its pid, so SIGKILL at the limit ends the sleep too. */
export const NEVER_ENDS = "#!/bin/sh\nexec sleep 30\n";

/** Writes `text` to `path` as a script that runs. */
export function writeScript(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** Runs `fn` with the limit of `kind` at `ms`, and restores the limit after. */
export function withLimit<T>(kind: LimitKind, ms: number, fn: () => T): T {
  const restore = setLimitForTest(kind, ms);
  try {
    return fn();
  } finally {
    restore();
  }
}

/**
 * Runs `fn` with a script named `name` first on PATH, with the text `text`.
 * PATH comes back after, and the folder of the script goes.
 */
export function withCommand<T>(name: string, text: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), `authtempo-fake-${name}-`));
  const path = process.env.PATH;
  writeScript(join(dir, name), text);
  process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
  try {
    return fn();
  } finally {
    if (path === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` with a `git` first on PATH that never ends, and with the git limit
 * at STALL_MS. So each git call of `fn` throws a RunTimeout, as a hung git does
 * at the real limit. PATH and the limit come back after.
 */
export function withStalledGit<T>(fn: () => T): T {
  return withCommand("git", NEVER_ENDS, () => withLimit("git", STALL_MS, fn));
}
