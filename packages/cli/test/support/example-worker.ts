import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { PKG, REPO } from "./bin.js";

const WORKER = join(REPO, "examples/worker");
const WRANGLER = join(WORKER, "node_modules/.bin/wrangler");
/**
 * A fixed operator secret for the tests that need a value of the right form
 * (plan 11c Task 2). A started Worker does not hold it: each start makes its
 * own secret (plan 12e, review I1).
 */
export const OPERATOR_SECRET = "authtempo-example-operator-secret-0123456789";
/** The SHA-256 hex of OPERATOR_SECRET. No report may print it (plan 11c2 Task 5). */
export const OPERATOR_HASH = "9553f46eb9e964b487a02e36147c562555bf1a684cfa614904bcc0f5ab5f1c57";
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
 * Each fetch of a live test, on a new connection that ends after its answer.
 * The tests run the binary with spawnSync, which blocks the event loop. The
 * dev server closes a connection after about 5 s with no request, and a
 * blocked loop does not see that close. The next fetch then sends on the
 * closed pooled socket and fails with ECONNRESET. That happened under a load
 * over 40, where a run of the binary takes more than 5 s (fix-12f2-live,
 * 2026-10-25). With "connection: close", no request uses an old socket, so
 * no request is sent twice and a POST needs no retry.
 */
export function liveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(url, { ...init, headers });
}

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
 * A port that no listener holds now, from the system (port 0). Each run then
 * starts its Worker on its own port, so two runs at once never share one
 * Worker. Plan 12e, review I1: two runs on the fixed port 8797 shared one.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * What the status of the operator info probe proves (plan 12e Task 1, R-L1).
 * A 200 to this run's secret: the Worker is this run's own. Another status:
 * another server holds the port. No answer in time: a slow Worker under
 * load, so the start asks again until its deadline.
 */
export function ownerOf(status: number | null): "own" | "other" | "wait" {
  if (status === null) return "wait";
  return status === 200 ? "own" : "other";
}

/** One started Worker: its base URL and port, the operator secret it holds, and its stop. */
export interface ExampleWorker {
  base: string;
  port: number;
  operatorSecret: string;
  operatorHash: string;
  stop(): Promise<void>;
}

/**
 * `wrangler dev` of examples/worker on a fresh local D1 in .scaffold/
 * (plan 11c), with BASE_URL set to the local origin, so the issuer of the
 * well-known documents is the base of the check. As examples/worker/proof/dev.mjs
 * does, wrangler runs in its own process group, and stop() ends the group.
 * A signal or the exit of the test process ends the group too.
 *
 * The port is free when the run starts, but another process can take it
 * before wrangler binds it. So the start proves that the answering server is
 * its own. The Worker holds a secret of this run only, and the operator info
 * route must accept it. Another Worker on the port refuses it, and the start
 * fails with that name. With `operatorUsers`, the Worker holds the secret
 * as the named secret "live" with the scopes users and sessions. The user
 * tools of plan 12f are then on. With `readiness` (plan 12h Task 9), the
 * Worker gets TEST_READINESS: "on" mounts the readiness route, and
 * "store_down" mounts it over a database binding that throws.
 */
export async function startExampleWorker(
  options: { operatorUsers?: boolean; readiness?: "on" | "store_down" } = {},
): Promise<ExampleWorker> {
  const deadline = Date.now() + START_LIMIT_MS;
  const port = await freePort();
  // wrangler picks the devtools port itself: 9229, else the next free one. That pick is a
  // check and then a bind, so two starts at once can pick one port. Then one workerd fails
  // with "bind(): Address already in use" (seen 2026-10-19). So the run names that port too.
  const inspectorPort = await freePort();
  const operatorSecret = `authtempo-live-${randomBytes(24).toString("hex")}`;
  const operatorHash = createHash("sha256").update(operatorSecret, "utf8").digest("hex");
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
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      persist,
      "--var",
      `BASE_URL:${base}`,
      "--var",
      "TEST_MODE:0",
      ...(options.readiness === undefined ? [] : ["--var", `TEST_READINESS:${options.readiness}`]),
      "--var",
      "AUTH_SECRET:0123456789abcdef0123456789abcdef",
      // The user tools of plan 12f need a named secret with their scopes (OPERATOR_SECRETS).
      ...(options.operatorUsers === true
        ? [
            "--var",
            `OPERATOR_SECRETS:${JSON.stringify([
              { name: "live", secretHash: operatorHash, scopes: ["users", "sessions"] },
            ])}`,
            "--var",
            "OPERATOR_USERS:1",
          ]
        : ["--var", `OPERATOR_SECRET_HASH:${operatorHash}`]),
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
  let infoSilent = false;
  while (child.exitCode === null && Date.now() < deadline - 5000) {
    const r = await liveFetch(`${base}/auth/session`, { signal: AbortSignal.timeout(2000) }).catch(
      () => null,
    );
    if (r?.status === 401) {
      // A 401 comes from any Worker of this example. Only this run's Worker accepts its secret.
      const own = await liveFetch(`${base}/auth/operator/info`, {
        headers: { authorization: `Operator ${operatorSecret}` },
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      const owner = ownerOf(own?.status ?? null);
      if (owner === "own" && child.exitCode === null)
        return { base, port, operatorSecret, operatorHash, stop };
      if (owner === "other") {
        await stop();
        throw new Error(
          `another server answers on ${base}: the operator info route answered ${own?.status} to this run's secret. ${log.slice(-2000)}`,
        );
      }
      infoSilent = true;
    }
    await sleep(300);
  }
  await stop();
  throw new Error(
    infoSilent
      ? `wrangler dev answered on ${base}, but the operator info route never answered in time: ${log.slice(-2000)}`
      : `wrangler dev did not answer on ${base}: ${log.slice(-2000)}`,
  );
}
