// The confined Io of the local tools (plan 11e Task 7). A tool runs the CLI's
// main in process through this Io. It writes nothing on the process's
// stdout, which carries only MCP messages. It runs no child process, and it
// reaches no path outside the server root (the root rule).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Io } from "@authtempo/cli/program";

/** A path that resolves outside the server root. The tool answers it as a tool fault. */
export class RootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootError";
  }
}

/** True when `path` is `base` or under it at a `/` boundary: /a/root2 is not under /a/root. */
function within(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

const code = (e: unknown) => (e as { code?: unknown }).code;

/**
 * The path with each link resolved: the realpath of the path, or of its
 * nearest existing ancestor with the missing names after it. A link that
 * names no file is refused, because a write through it can land anywhere.
 */
function resolveReal(path: string): string {
  const missing: string[] = [];
  let head = path;
  for (;;) {
    try {
      return join(realpathSync(head), ...missing);
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
    }
    let isLink = false;
    try {
      isLink = lstatSync(head).isSymbolicLink();
    } catch {
      // No entry at this name: go up one folder.
    }
    if (isLink) throw new RootError(`the path ${path} holds a link that names no file`);
    const parent = dirname(head);
    if (parent === head) throw new RootError(`the path ${path} has no folder that exists`);
    missing.unshift(basename(head));
    head = parent;
  }
}

/**
 * The root rule (plan 11e): resolves `path` against the root, resolves each
 * link of it by realpath, and answers the result. It throws RootError when
 * the result is not the root or a path under it.
 */
export function insideRoot(root: string, path: string): string {
  const base = realpathSync(root);
  const real = resolveReal(resolve(base, path));
  if (!within(base, real)) throw new RootError(`the path ${path} resolves outside the server root`);
  return real;
}

/** The Io of a tool, and the lines that the run printed. */
export interface ConfinedIo {
  io: Io;
  lines(): { out: string[]; err: string[] };
}

/**
 * An Io that keeps the CLI inside the root. Reads may also reach each path
 * of `readOnly`, such as the init templates of the CLI. No write reaches
 * them. `fetch` runs only with `allowFetch`.
 */
export function confinedIo(opts: {
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  allowFetch: boolean;
  readOnly?: readonly string[];
}): ConfinedIo {
  const root = realpathSync(opts.root);
  const readable = (opts.readOnly ?? []).map((d) => realpathSync(d));
  const out: string[] = [];
  const err: string[] = [];
  /** A path that a read may reach: inside the root, or inside a read-only folder. */
  const readPath = (path: string): string => {
    try {
      return insideRoot(root, path);
    } catch (e) {
      if (!(e instanceof RootError)) throw e;
      const real = resolveReal(resolve(root, path));
      if (readable.some((d) => within(d, real))) return real;
      throw e;
    }
  };
  /**
   * A new file inside the root. write is synchronous, so only another
   * process can put a link in the path after the first check. The second
   * check after mkdir makes that window smaller. It does not close it: a gap
   * stays before writeFileSync, and mkdir can make empty folders outside the
   * root before the refusal. The flag wx refuses a file or a link at the target.
   */
  const write = (path: string, text: string, mode: number): void => {
    const target = insideRoot(root, path);
    if (existsSync(target))
      throw new Error(`the file ${target} exists; a tool writes no file over a file`);
    mkdirSync(dirname(target), { recursive: true });
    const parent = insideRoot(root, dirname(target));
    writeFileSync(join(parent, basename(target)), text, { flag: "wx", mode });
  };
  const io: Io = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    env: opts.env,
    cwd: root,
    stdinIsTTY: false,
    readFile: (path) => readFileSync(readPath(path), "utf8"),
    readStdin: () => {
      throw new Error("no stdin in the MCP server");
    },
    exists: (path) => existsSync(readPath(path)),
    realpath: (path) => realpathSync(readPath(path)),
    fileMode: (path) => statSync(readPath(path)).mode & 0o777,
    listDir: (path) => readdirSync(readPath(path)),
    writeNew: (path, text) => write(path, text, 0o666),
    writePrivate: (path, text) => write(path, text, 0o600),
    replaceFile: () => {
      throw new Error("no tool rewrites a file");
    },
    // The root rule writes no secret file (spec 21 item 4): no tool wraps `authtempo secret`.
    writeNewPrivate: () => {
      throw new RootError("the MCP server writes no secret file");
    },
    // The Web Crypto source, as the CLI's own io.
    randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fetch: (url, init) => {
      if (!opts.allowFetch) return Promise.reject(new Error("this tool makes no network call"));
      return fetch(url, init);
    },
    run: () => Promise.reject(new Error("this tool runs no child process")),
    confirm: async () => false,
    // No tool runs a command that asks: the empty line matches no answer.
    prompt: async () => "",
  };
  return { io, lines: () => ({ out: [...out], err: [...err] }) };
}
