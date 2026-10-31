import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder of @authtempo/cli, and the root of the repo. */
export const PKG = fileURLToPath(new URL("../../", import.meta.url));
export const REPO = join(PKG, "../../");
export const BIN = join(PKG, "dist/bin/authtempo.js");
export const ALIAS = join(PKG, "dist/bin/authtempo-import.js");
/**
 * The version of each package by its folder under packages/, from its
 * package.json. A test reads the version of the package under test here,
 * never a literal: `changeset version` moves each manifest, and a test that
 * pins 0.0.0 fails on the version branch (ruling 65 of plan 12j, C1).
 */
export const versionOf = (pkg: string): string =>
  (
    JSON.parse(readFileSync(join(REPO, "packages", pkg, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
/** The version of this CLI. */
export const VERSION = versionOf("cli");
/**
 * A generated file with the version of the CLI in its header as a slot, so a
 * file snapshot holds at each version. A header with another version keeps it.
 */
export const versionSlot = (text: string): string =>
  text.replace(`authtempo CLI ${VERSION}.`, "authtempo CLI <version>.");
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

/**
 * A built CLI at `version`: a copy of dist beside a manifest at that version,
 * with a link to the node_modules of the package. A probe of one release
 * state runs on this copy, never on the tree, so it holds at each version of
 * the tree (ruling 65 of plan 12j, C1). The copy keeps private: true, as the
 * version branch does. Call `remove` when the probe ends.
 */
export function cliAt(version: string): { bin: string; dir: string; remove: () => void } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-cli-at-")));
  const dir = join(tmp, "cli");
  cpSync(join(PKG, "dist"), join(dir, "dist"), { recursive: true });
  const real = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as object;
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ ...real, version, private: true }, null, 2)}\n`,
  );
  symlinkSync(join(PKG, "node_modules"), join(dir, "node_modules"), "dir");
  return {
    bin: join(dir, "dist/bin/authtempo.js"),
    dir,
    remove: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
