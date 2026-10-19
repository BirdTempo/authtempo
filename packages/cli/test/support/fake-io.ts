import type { Io, RunResult } from "../../src/io.js";

export interface FakeIo extends Io {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly files: Map<string, string>;
  /** Each path that readFile read, in order. */
  readonly reads: string[];
  readonly requests: { url: string; method: string; headers: Headers }[];
}

/**
 * A memory io for the command tests (plan 11c). Paths are absolute keys of
 * `files`; `cwd` is /work. A fetch with no `fetch` option fails as a host
 * that gives no answer.
 */
export function fakeIo(
  o: {
    env?: Record<string, string>;
    files?: Record<string, string>;
    stdin?: string;
    stdinIsTTY?: boolean;
    cwd?: string;
    /** The mode of a file by its path; a file with no entry has mode 0600. */
    modes?: Record<string, number>;
    answer?: boolean;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    run?: (command: string, args: readonly string[], cwd: string) => Promise<RunResult>;
    /** The random bytes of `randomBytes`. The default fills each byte from a counter, so a test can predict it. */
    random?: (n: number) => Uint8Array;
  } = {},
): FakeIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reads: string[] = [];
  const requests: FakeIo["requests"] = [];
  const files = new Map(Object.entries(o.files ?? {}));
  return {
    stdout,
    stderr,
    files,
    reads,
    requests,
    out: (line) => {
      stdout.push(line);
    },
    err: (line) => {
      stderr.push(line);
    },
    env: o.env ?? {},
    cwd: o.cwd ?? "/work",
    stdinIsTTY: o.stdinIsTTY ?? false,
    readFile(path) {
      reads.push(path);
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    readStdin: () => o.stdin ?? "",
    exists: (path) => files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`)),
    // The memory files hold no link.
    realpath: (path) => path,
    fileMode: (path) => o.modes?.[path] ?? 0o600,
    listDir(path) {
      const prefix = `${path}/`;
      const names = [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length).split("/")[0] ?? "");
      return [...new Set(names)].sort();
    },
    writeNew(path, text) {
      if (files.has(path)) throw new Error(`EEXIST: ${path}`);
      files.set(path, text);
    },
    writePrivate(path, text) {
      files.set(path, text);
    },
    replaceFile(path, text) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      files.set(path, text);
    },
    writeNewPrivate(path, text) {
      if (files.has(path)) throw new Error(`EEXIST: ${path}`);
      files.set(path, text);
    },
    randomBytes: o.random ?? ((n) => Uint8Array.from({ length: n }, (_, i) => i & 0xff)),
    runtime: { node: "v26.10.0", platform: "linux", arch: "x64" },
    async fetch(url, init) {
      requests.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers) });
      if (!o.fetch) throw new TypeError("fetch failed");
      return o.fetch(url, init);
    },
    async run(command, args, options) {
      if (!o.run) throw new Error(`no child process in this test: ${command}`);
      return o.run(command, args, options.cwd);
    },
    async confirm() {
      return o.answer ?? false;
    },
  };
}
