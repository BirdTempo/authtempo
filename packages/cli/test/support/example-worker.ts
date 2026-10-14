import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PKG, REPO } from "./bin.js";

const WORKER = join(REPO, "examples/worker");
const WRANGLER = join(WORKER, "node_modules/.bin/wrangler");
/** The secret whose SHA-256 hex the Worker gets as OPERATOR_SECRET_HASH (plan 11c Task 2). */
export const OPERATOR_SECRET = "authtempo-example-operator-secret-0123456789";
const OPERATOR_HASH = "9553f46eb9e964b487a02e36147c562555bf1a684cfa614904bcc0f5ab5f1c57";
// CI=1: wrangler takes the default of each question (examples/worker/proof/dev.mjs, read 2026-10-10).
const ENV = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `wrangler dev` of examples/worker on a fresh local D1 in .scaffold/
 * (plan 11c), with BASE_URL set to the local origin, so the issuer of the
 * well-known documents is the base of the check. As examples/worker/proof/dev.mjs
 * does, wrangler runs in its own process group, and stop() ends the group.
 */
export async function startExampleWorker(
  port: number,
): Promise<{ base: string; stop(): Promise<void> }> {
  const base = `http://localhost:${port}`;
  const busy = await fetch(base, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`port ${port} answers already; stop the other server first`);
  mkdirSync(join(PKG, ".scaffold"), { recursive: true });
  const persist = mkdtempSync(join(PKG, ".scaffold", "worker-state-"));
  const apply = spawnSync(
    WRANGLER,
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
    {
      cwd: WORKER,
      env: ENV,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (apply.status !== 0)
    throw new Error(`wrangler d1 migrations apply failed: ${apply.stdout}${apply.stderr}`);
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--var",
      `BASE_URL:${base}`,
      "--var",
      "TEST_MODE:0",
      "--var",
      "AUTH_SECRET:0123456789abcdef0123456789abcdef",
      "--var",
      `OPERATOR_SECRET_HASH:${OPERATOR_HASH}`,
    ],
    { cwd: WORKER, env: ENV, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  child.stdout?.on("data", (d) => {
    log += String(d);
  });
  child.stderr?.on("data", (d) => {
    log += String(d);
  });
  const group = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // The group ended already.
    }
  };
  const stop = async () => {
    group("SIGTERM");
    await sleep(1000);
    group("SIGKILL");
    rmSync(persist, { recursive: true, force: true, maxRetries: 3 });
  };
  for (let i = 0; i < 300 && child.exitCode === null; i++) {
    const r = await fetch(`${base}/auth/session`, { signal: AbortSignal.timeout(2000) }).catch(
      () => null,
    );
    if (r?.status === 401) return { base, stop };
    await sleep(300);
  }
  await stop();
  throw new Error(`wrangler dev did not answer on ${base}: ${log.slice(-2000)}`);
}
