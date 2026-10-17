import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder of @authtempo/mcp, and the root of the repo. */
export const PKG = fileURLToPath(new URL("../../", import.meta.url));
export const REPO = join(PKG, "../../");
export const BIN = join(PKG, "dist/bin/authtempo-mcp.js");
/** The copy of the agent index that the binary reads by default (scripts/copy-index.mjs). */
export const COPY = join(PKG, "dist/agent/index.json");

export function newestUnder(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) max = Math.max(max, statSync(join(e.parentPath, e.name)).mtimeMs);
  return max;
}

/**
 * Fails when the build is older than a file of src (spec 19, the evidence
 * rules). A child-process test that reads an old build proves nothing.
 */
export function assertFreshBuild(): void {
  let built: number;
  try {
    built = statSync(BIN).mtimeMs;
  } catch {
    throw new Error(`${BIN} is missing: run pnpm --filter @authtempo/mcp build`);
  }
  if (built < newestUnder(join(PKG, "src")))
    throw new Error(`${BIN} is older than src/: run pnpm --filter @authtempo/mcp build`);
}

export interface ServerRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** The id of each request among the lines: the run waits for one answer to each. */
function requestIds(lines: readonly string[]): unknown[] {
  const ids: unknown[] = [];
  for (const line of lines) {
    let m: { id?: unknown; method?: unknown };
    try {
      m = JSON.parse(line) as { id?: unknown; method?: unknown };
    } catch {
      // A line that is not JSON gets an answer with id null: no request id to wait for.
      continue;
    }
    if (m.id !== undefined && typeof m.method === "string") ids.push(m.id);
  }
  return ids;
}

/** The ids of the answers that a stdout text holds so far. A line that does not parse has no id. */
function answeredIds(stdout: string): unknown[] {
  const ids: unknown[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const m = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (m.id !== undefined && m.method === undefined) ids.push(m.id);
    } catch {
      // Not a message: the stdout test reports it.
    }
  }
  return ids;
}

/**
 * Runs dist/bin/authtempo-mcp.js with a small environment, writes each line
 * to its stdin, and closes stdin. The SDK aborts each request that is still
 * open when stdin ends (stdio.d.mts of @modelcontextprotocol/server 2.3.1,
 * read 2026-10-17). So the run closes stdin only after each request has its
 * answer, or after the time limit.
 */
export function runServer(
  args: readonly string[],
  lines: readonly string[],
  o: { env?: Record<string, string>; limitMs?: number } = {},
): Promise<ServerRun> {
  const wanted = requestIds(lines);
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: PKG,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ...o.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const started = Date.now();
  const limit = o.limitMs ?? 20_000;
  return new Promise((resolve, reject) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      child.stdin.end();
    };
    const check = () => {
      const got = answeredIds(stdout);
      if (wanted.every((id) => got.includes(id)) || Date.now() - started > limit) end();
    };
    child.stdout.on("data", (d: string) => {
      stdout += d;
      check();
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    const timer = setInterval(check, 50);
    child.on("close", (code) => {
      clearInterval(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    // A run that exits before it reads stdin (a usage error) closes the pipe first.
    child.stdin.on("error", () => {});
    for (const line of lines) child.stdin.write(`${line}\n`);
    if (wanted.length === 0) end();
  });
}

/** The lines of a text that are not empty. */
export const linesOf = (text: string): string[] => text.split("\n").filter((l) => l.length > 0);
