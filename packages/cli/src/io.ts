import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";

/** The answer of a child process. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Every effect of the CLI goes through this port (spec 19): the output
 * lines, the files, the environment, the network, the child processes, and
 * the prompt. A test passes a fake; `nodeIo` is the real one. Paths are
 * absolute: a command resolves a flag's path against `cwd`.
 */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly stdinIsTTY: boolean;
  readFile(path: string): string;
  readStdin(): string;
  exists(path: string): boolean;
  /** The path with each link resolved. The path must exist. */
  realpath(path: string): string;
  listDir(path: string): string[];
  /** Makes the folders on the way, and refuses a file that exists. */
  writeNew(path: string, text: string): void;
  writePrivate(path: string, text: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<RunResult>;
  confirm(question: string): Promise<boolean>;
}

/**
 * Writes a file that only its owner can read (mode 0600). The text goes to a
 * new file in the same directory and is renamed over the target, so a target
 * that exists with a wider mode never holds the new text: writeFileSync's mode
 * applies only to a file it creates (moved from the import CLI, review M-2).
 */
export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The real io: the process's streams, files, environment, fetch, and child processes. */
export function nodeIo(): Io {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: process.stdin.isTTY === true,
    readFile: (path) => readFileSync(path, "utf8"),
    readStdin: () => readFileSync(0, "utf8"),
    exists: (path) => existsSync(path),
    realpath: (path) => realpathSync(path),
    listDir: (path) => readdirSync(path),
    writeNew(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { flag: "wx" });
    },
    writePrivate,
    fetch: (url, init) => fetch(url, init),
    run: (command, args, options) =>
      new Promise((done, fail) => {
        // stdin is closed: a child that asks a question reads the end of input.
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => {
          stdout += d;
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
          stderr += d;
        });
        child.on("error", fail);
        child.on("close", (status) => done({ status: status ?? -1, stdout, stderr }));
      }),
    async confirm(question) {
      // The question goes to stderr, so stdout keeps the result only.
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}
