import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { PKG, REPO } from "./bin.js";

const WORKER = join(REPO, "examples/worker");
const WRANGLER = join(WORKER, "node_modules/.bin/wrangler");
/** The secret whose SHA-256 hex the Worker gets as OPERATOR_SECRET_HASH (plan 11c Task 2). */
export const OPERATOR_SECRET = "authtempo-example-operator-secret-0123456789";
const OPERATOR_HASH = "9553f46eb9e964b487a02e36147c562555bf1a684cfa614904bcc0f5ab5f1c57";
// CI=1: wrangler takes the default of each question (examples/worker/proof/dev.mjs, read 2026-10-10).
// The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
const ENV = {
  ...process.env,
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  NO_COLOR: "1",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The longest time startExampleWorker takes, the stop included. The hook that
 * calls it gets a longer limit (START_LIMIT_MS + 30 s), so the start always
 * ends inside the hook: on a timeout of the hook, afterAll has no worker to
 * stop while wrangler still runs (review of plan 11c Task 8).
 */
export const START_LIMIT_MS = 150_000;
const APPLY_LIMIT_MS = 90_000;

// Each running Worker registers a sync kill here, as examples/worker/proof/dev.mjs does.
// Wrangler runs in its own process group (detached), so a Ctrl-C of vitest does not reach
// it. Without these handlers an interrupted run leaves workerd on the port, and the next
// run stops at the port check.
const killers = new Set<() => void>();
let handlersInstalled = false;
function killAll(): void {
  for (const kill of killers) kill();
}
function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", killAll);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(code);
    });
  }
}

/** True when a TCP connect to the port succeeds: a listener of any protocol holds it. */
function portTaken(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * `wrangler dev` of examples/worker on a fresh local D1 in .scaffold/
 * (plan 11c), with BASE_URL set to the local origin, so the issuer of the
 * well-known documents is the base of the check. As examples/worker/proof/dev.mjs
 * does, wrangler runs in its own process group, and stop() ends the group.
 * A signal or the exit of the test process ends the group too.
 */
export async function startExampleWorker(
  port: number,
): Promise<{ base: string; stop(): Promise<void> }> {
  const deadline = Date.now() + START_LIMIT_MS;
  const base = `http://localhost:${port}`;
  // localhost can resolve to either address: a listener on either one takes the port.
  for (const host of ["127.0.0.1", "::1"])
    if (await portTaken(host, port))
      throw new Error(`port ${port} is in use on ${host}; stop the other server first`);
  mkdirSync(join(PKG, ".scaffold"), { recursive: true });
  const persist = mkdtempSync(join(PKG, ".scaffold", "worker-state-"));
  const apply = spawnSync(
    WRANGLER,
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
    {
      cwd: WORKER,
      env: ENV,
      encoding: "utf8",
      timeout: APPLY_LIMIT_MS,
    },
  );
  if (apply.status !== 0) {
    rmSync(persist, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(`wrangler d1 migrations apply failed: ${apply.stdout}${apply.stderr}`);
  }
  installHandlers();
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
  // The signal path also removes the persist folder, as stop does.
  const killSync = () => {
    group("SIGKILL");
    rmSync(persist, { recursive: true, force: true });
  };
  killers.add(killSync);
  const stop = async () => {
    group("SIGTERM");
    await sleep(1000);
    group("SIGKILL");
    killers.delete(killSync);
    rmSync(persist, { recursive: true, force: true, maxRetries: 3 });
  };
  // The loop ends 5 s before the deadline, so the stop below ends inside START_LIMIT_MS.
  while (child.exitCode === null && Date.now() < deadline - 5000) {
    const r = await fetch(`${base}/auth/session`, { signal: AbortSignal.timeout(2000) }).catch(
      () => null,
    );
    if (r?.status === 401) return { base, stop };
    await sleep(300);
  }
  await stop();
  throw new Error(`wrangler dev did not answer on ${base}: ${log.slice(-2000)}`);
}
