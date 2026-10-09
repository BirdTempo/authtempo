// The shared kit for the plan 6c device proofs. It starts the example Worker under
// `wrangler dev` on a fresh local D1, and plays the browser part of a handoff over HTTP
// with the same requests as test/handoff.e2e.test.ts. A proof that needs a real browser
// drives one itself.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "http://localhost:8787";
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every fetch in the kit has a timeout. A hung connection must not stretch a limit.
const http = (url, init = {}) => fetch(url, { signal: AbortSignal.timeout(10_000), ...init });

async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

// Each running Worker registers a sync kill here. The handlers below call them on Ctrl-C,
// on SIGTERM, on SIGHUP, and on any exit. SIGHUP comes when the terminal closes; Node's default
// action for it ends the process with no exit event, so without the handler the Worker stays. Wrangler runs in its own process group (detached), so a signal
// to this process does not reach it. Without these handlers an interrupted proof leaves an
// orphan on port 8787, and the next run stops at the "port answers already" check.
const killers = new Set();
let handlersInstalled = false;
function killAll() {
  for (const kill of killers) kill();
}
function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", killAll);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    process.on(signal, () => {
      killAll();
      process.exit(code);
    });
  }
}

async function waitFor(condition, ms) {
  for (let t = 0; t < ms; t += 100) {
    if (await condition()) return true;
    await sleep(100);
  }
  return false;
}

export async function startWorker() {
  if (await answers(BASE))
    throw new Error(`port 8787 answers already; stop the other wrangler dev first`);
  const persist = mkdtempSync(join(tmpdir(), "tempo-auth-proof-d1-"));
  // CI=1 makes wrangler skip its confirm prompt.
  const env = { ...process.env, CI: "1" };
  // Every child process in the proofs has a limit. The local apply takes a few seconds; 2 min
  // allows a loaded machine. A stuck apply then fails the run and never hangs it.
  try {
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
      { cwd: WORKER_DIR, env, stdio: "inherit", timeout: 120_000 },
    );
  } catch (e) {
    rmSync(persist, { recursive: true, force: true, maxRetries: 3 });
    throw e;
  }
  const logFile = join(persist, "wrangler-dev.log");
  const log = openSync(logFile, "w");
  // wrangler 4.148.0 splits a --var on the first colon and joins the rest, so a URL value is safe
  // (collectKeyValues in wrangler-dist/cli.js, read 2026-10-10).
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--port",
      "8787",
      "--persist-to",
      persist,
      "--var",
      `BASE_URL:${BASE}`,
      "--var",
      "TEST_MODE:1",
      "--var",
      `AUTH_SECRET:${randomBytes(32).toString("hex")}`,
    ],
    // detached puts pnpm, wrangler, and workerd in one process group, so stop() ends all three.
    { cwd: WORKER_DIR, env, stdio: ["ignore", log, log], detached: true },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  // Sync part: ends the process group and removes the temp directory. Safe to call twice.
  // It runs in an exit listener, where a throw stops the listeners after it. So the remove
  // retries (workerd can still hold a file for a moment) and never throws.
  const killSync = () => {
    killGroup("SIGKILL");
    killers.delete(killSync);
    try {
      rmSync(persist, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  };
  killers.add(killSync);
  installHandlers();
  // Waits until the port is closed, so the next startWorker does not see this Worker.
  // When the second wait ends, it still sends SIGKILL and removes the temp directory, then
  // throws. A caller that skips its own cleanup on this throw then leaves no Worker behind.
  const stop = async () => {
    killGroup("SIGTERM");
    if (!(await waitFor(async () => !(await answers(BASE)), 10_000))) killGroup("SIGKILL");
    const stopped = await waitFor(async () => !(await answers(BASE)) && exited, 10_000);
    killSync();
    if (!stopped) throw new Error("wrangler dev did not stop in 20 s");
  };
  for (let i = 0; i < 300 && !exited; i++) {
    try {
      const r = await http(`${BASE}/__test/last-link`);
      if (r.status === 200) return { persist, logFile, stop };
    } catch {}
    await sleep(200);
  }
  // The log goes into the error because stop() removes the directory that holds it.
  const tail = readFileSync(logFile, "utf8").slice(-2000);
  await stop();
  throw new Error(
    `wrangler dev ${exited ? "exited" : "did not answer in 60 s"}; its log ended with:\n${tail}`,
  );
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function expectStatus(res, status, step) {
  if (res.status !== status) throw new Error(`${step} answered ${res.status}, expected ${status}`);
}

export async function playBrowser(startUrl, email) {
  const start = await http(startUrl, { redirect: "manual" });
  expectStatus(start, 200, "GET /auth/handoff/start");
  const cont = /data-continue="([^"]+)"/.exec(await start.text())?.[1];
  if (!cont?.startsWith("/auth/handoff/continue?h=hs_"))
    throw new Error("no continue path on the start page");
  const req = await http(`${BASE}/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, next: cont }),
  });
  expectStatus(req, 200, "POST /auth/magic-link/request");
  const { link } = await (await http(`${BASE}/__test/last-link`)).json();
  // This proves that --var BASE_URL took effect: core builds the link from baseURL.
  // The error must not print the link: it holds a live token.
  if (!link?.startsWith(`${BASE}/`)) throw new Error(`the magic link is not on ${BASE}`);
  const token = new URL(link).searchParams.get("token") ?? "";
  const verify = await http(`${BASE}/auth/magic-link/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ token }).toString(),
  });
  expectStatus(verify, 302, "POST /auth/magic-link/verify");
  // The e2e test checks the same: verify returns to the continue path.
  if (verify.headers.get("location") !== `${BASE}${cont}`)
    throw new Error("POST /auth/magic-link/verify did not redirect to the continue path");
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const confirm = await http(`${BASE}${cont}`, { redirect: "manual", headers: { cookie } });
  expectStatus(confirm, 200, "GET the continue path");
  if (!(await confirm.text()).includes("Continue to tempo-auth example?"))
    throw new Error("the continue page has no confirm prompt");
  const h = new URL(`${BASE}${cont}`).searchParams.get("h") ?? "";
  const next = await http(`${BASE}/auth/handoff/continue`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie },
    body: new URLSearchParams({ h }).toString(),
  });
  expectStatus(next, 302, "POST /auth/handoff/continue");
  return next.headers.get("location") ?? "";
}

export async function bearerFor(email) {
  const { verifier, challenge } = pkce();
  const redirect = encodeURIComponent("example-app://auth");
  const location = await playBrowser(
    `${BASE}/auth/handoff/start?challenge=${challenge}&redirect=${redirect}`,
    email,
  );
  const code = new URL(location).searchParams.get("code") ?? "";
  const redeem = await http(`${BASE}/auth/handoff/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  expectStatus(redeem, 200, "POST /auth/handoff/redeem");
  return (await redeem.json()).token;
}
