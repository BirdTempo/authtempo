import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder of @authtempo/cli, and the root of the repo. */
export const PKG = fileURLToPath(new URL("../../", import.meta.url));
export const REPO = join(PKG, "../../");
export const BIN = join(PKG, "dist/bin/authtempo.js");
export const ALIAS = join(PKG, "dist/bin/authtempo-import.js");
/** The escape byte: the CLI writes no color and no terminal control (spec 19). */
export const ESC = "\u001b";

function newestUnder(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) max = Math.max(max, statSync(join(e.parentPath, e.name)).mtimeMs);
  return max;
}

/**
 * Fails when the build is older than a file of src (spec 19, the evidence
 * rules): a child-process test that reads an old build proves nothing.
 */
export function assertFreshBuild(): void {
  let built: number;
  try {
    built = statSync(BIN).mtimeMs;
  } catch {
    throw new Error(`${BIN} is missing: run pnpm --filter @authtempo/cli build`);
  }
  if (built < newestUnder(join(PKG, "src")))
    throw new Error(`${BIN} is older than src/: run pnpm --filter @authtempo/cli build`);
}

export interface BinRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary of the package as a child process with a small environment:
 * PATH, HOME, TMPDIR, and the variables of the test. A variable of the
 * developer's shell, such as DATABASE_URL, never reaches the command. The
 * input is a pipe, so stdin is never a terminal.
 */
export function runBin(
  args: readonly string[],
  o: { env?: Record<string, string>; cwd?: string; input?: string; bin?: string } = {},
): BinRun {
  const r = spawnSync(process.execPath, [o.bin ?? BIN, ...args], {
    cwd: o.cwd ?? PKG,
    encoding: "utf8",
    input: o.input ?? "",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ...o.env,
    },
    timeout: 300_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const linesOf = (text: string): string[] => text.split("\n").filter((l) => l.length > 0);
