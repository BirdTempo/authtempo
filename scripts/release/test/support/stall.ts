import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type LimitKind, setLimitForTest } from "../../src/lib/run-sync.ts";

/** The limit of a stalled call in a test, in ms. */
export const STALL_MS = 300;

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
 * Runs `fn` with a `git` first on PATH that never ends, and with the git limit
 * at STALL_MS. So each git call of `fn` throws a RunTimeout, as a hung git does
 * at the real limit. PATH and the limit come back after.
 */
export function withStalledGit<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-stalled-git-"));
  const path = process.env.PATH;
  writeScript(join(dir, "git"), NEVER_ENDS);
  process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
  try {
    return withLimit("git", STALL_MS, fn);
  } finally {
    if (path === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}
