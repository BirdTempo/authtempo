// The performance run of plan 12h Task 15. A person runs it on a quiet
// machine: `pnpm --filter @authtempo/site run measure:performance`. No test
// runs it. It starts the measure entry of examples/worker-d1 under
// `wrangler dev --local`, measures the five operations of MEASURED_ROUTES,
// and writes src/data/performance.json and the block of the page from it.
// check-performance then holds the page to the record.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PBKDF2_ITERATIONS } from "@authtempo/core";
import { MEASURE_PREFIX, type MeasureLine } from "../../../examples/worker-d1/src/measure-line.ts";
import {
  MEASURED_END,
  MEASURED_ROUTES,
  MEASURED_START,
  PERFORMANCE_DATA,
  PERFORMANCE_PAGE,
  type PerformanceData,
  renderPerformanceTable,
  type Spread,
} from "./check-performance.ts";
import { DOCS, REPO, SITE } from "./lib/paths.ts";

const EXAMPLE = `${REPO}examples/worker-d1/`;
const WRANGLER = `${EXAMPLE}node_modules/.bin/wrangler`;
/** The four keys of every wrangler spawn (ruling 40 of plan 11e): the banner check can hold the child. */
const WRANGLER_ENV = {
  ...process.env,
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
  WRANGLER_HIDE_BANNER: "true",
};
const WARMUP = 20;
const SAMPLES = 200;
/**
 * The users of the run. The limits allow 10 sign-ins and 5 magic link mails
 * for each address in 15 minutes. 220 calls over 50 users stay under both.
 */
const USERS = 50;
/** The origin of wrangler.jsonc. The trusted origin check reads it on each POST. */
const ORIGIN = "https://example.test";
/**
 * The lead's rule for this run: the one-minute load at most a quarter of
 * the cores. check-performance refuses a load above the core count; this
 * stricter rule keeps the run far from that bound.
 */
const LOAD_SHARE = 0.25;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/** A free port from the OS: a fixed port collides with the tests of other lanes. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/**
 * A new client IP for each call. The limits count each IP, so one IP for
 * 220 calls measures 429 answers. Outside the edge the header passes through.
 */
let nextIp = 0;
function ip(): string {
  nextIp += 1;
  return `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp & 255}`;
}

/** The nearest-rank percentile of sorted values. */
function rank(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    p50: round(rank(sorted, 0.5)),
    p95: round(rank(sorted, 0.95)),
    max: round(sorted.at(-1) ?? Number.NaN),
  };
}

/** The dev server and the lines it wrote. */
interface Server {
  child: ChildProcess;
  base: string;
  lines: MeasureLine[];
  output: string[];
}

function startServer(port: number, state: string): Server {
  const child = spawn(
    WRANGLER,
    [
      "dev",
      `${EXAMPLE}src/measure.ts`,
      "--local",
      "--config",
      `${EXAMPLE}wrangler.jsonc`,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      `AUTH_SECRET:${randomBytes(32).toString("hex")}`,
      "--show-interactive-dev-session=false",
    ],
    { cwd: EXAMPLE, env: WRANGLER_ENV, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const server: Server = { child, base: `http://127.0.0.1:${port}`, lines: [], output: [] };
  let rest = "";
  const read = (chunk: Buffer) => {
    const text = rest + chunk.toString("utf8");
    const parts = text.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) {
      server.output.push(line);
      const at = line.indexOf(MEASURE_PREFIX);
      if (at >= 0)
        server.lines.push(JSON.parse(line.slice(at + MEASURE_PREFIX.length)) as MeasureLine);
    }
  };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  return server;
}

/** Stops wrangler and its workerd child: the whole process group. */
async function stopServer(server: Server): Promise<void> {
  const { child } = server;
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  process.kill(-child.pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  }, 10_000);
  await exited;
  clearTimeout(timer);
}

async function waitFor(what: string, ms: number, ok: () => boolean | Promise<boolean>) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`measure-performance: no ${what} after ${ms} ms`);
}

/** One call: the client time covers the request and the whole body. */
async function call(
  server: Server,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ res: Response; body: string; ms: number; trace: string }> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip() };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    headers.origin = ORIGIN;
  }
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const started = performance.now();
  const res = await fetch(`${server.base}${path}`, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await res.text();
  const ms = performance.now() - started;
  return { res, body, ms, trace: res.headers.get("x-authtempo-trace") ?? "" };
}

/** The session cookie of an answer, as a cookie header. */
function sessionCookie(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.includes("tempo_session="));
  return set?.split(";")[0] ?? "";
}

interface User {
  email: string;
  password: string;
  cookie: string;
}

/** Signs up each user and opens the verify link of its mail. */
async function makeUsers(server: Server): Promise<User[]> {
  const users: User[] = [];
  for (let i = 0; i < USERS; i++) {
    const email = `measure-${i}@example.com`;
    const password = `Measure-${randomBytes(12).toString("hex")}`;
    const up = await call(server, "/auth/password/sign-up", {
      method: "POST",
      body: { email, password },
    });
    if (up.res.status !== 200) throw new Error(`sign-up ${up.res.status}: ${up.body}`);
    users.push({ email, password, cookie: "" });
  }
  await waitFor("verify mail of each user", 30_000, () =>
    users.every((u) => server.lines.some((l) => l.kind === "mail" && l.to === u.email)),
  );
  for (const u of users) {
    const mail = server.lines.find((l) => l.kind === "mail" && l.to === u.email);
    const link = mail?.kind === "mail" ? /https?:\/\/\S+/.exec(mail.text)?.[0] : undefined;
    if (link === undefined) throw new Error(`no verify link for ${u.email}`);
    const url = new URL(link);
    const verify = await call(server, `${url.pathname}${url.search}`);
    if (verify.res.status >= 400) throw new Error(`verify ${verify.res.status}: ${verify.body}`);
  }
  return users;
}

type Op = (n: number) => Promise<{ status: number; ms: number; trace: string; body: string }>;

function operations(server: Server, users: User[]): Record<(typeof MEASURED_ROUTES)[number], Op> {
  const user = (n: number): User => {
    const u = users[n % users.length];
    if (u === undefined) throw new Error("no user");
    return u;
  };
  const plain = async (path: string, init: Parameters<typeof call>[2] = {}) => {
    const r = await call(server, path, init);
    return { status: r.res.status, ms: r.ms, trace: r.trace, body: r.body };
  };
  return {
    "POST /password/sign-in": async (n) => {
      const u = user(n);
      const r = await call(server, "/auth/password/sign-in", {
        method: "POST",
        body: { email: u.email, password: u.password },
      });
      const cookie = sessionCookie(r.res);
      if (cookie !== "") u.cookie = cookie;
      return { status: r.res.status, ms: r.ms, trace: r.trace, body: r.body };
    },
    "GET /session": (n) => plain("/auth/session", { cookie: user(n).cookie }),
    "GET /token": (n) => plain("/auth/token", { cookie: user(n).cookie }),
    "GET /jwks": () => plain("/auth/jwks"),
    "POST /magic-link/request": (n) =>
      plain("/auth/magic-link/request", { method: "POST", body: { email: user(n).email } }),
  };
}

async function main(): Promise<void> {
  const dirty = git("status", "--porcelain");
  if (dirty !== "") throw new Error(`measure-performance: the tree is not clean:\n${dirty}`);
  const commit = git("rev-parse", "HEAD");
  const cores = os.cpus().length;
  const before = os.loadavg() as [number, number, number];
  if (before[0] > cores * LOAD_SHARE)
    throw new Error(
      `measure-performance: the one-minute load is ${before[0]}, above ${cores * LOAD_SHARE}; wait for a quiet machine`,
    );
  const wranglerVersion = (
    JSON.parse(readFileSync(`${EXAMPLE}node_modules/wrangler/package.json`, "utf8")) as {
      version: string;
    }
  ).version;
  const state = mkdtempSync(join(os.tmpdir(), "authtempo-measure-"));
  let server: Server | null = null;
  try {
    execFileSync(
      WRANGLER,
      [
        "d1",
        "migrations",
        "apply",
        "my-app",
        "--local",
        "--config",
        `${EXAMPLE}wrangler.jsonc`,
        "--persist-to",
        state,
      ],
      { cwd: EXAMPLE, env: WRANGLER_ENV, stdio: "ignore" },
    );
    server = startServer(await freePort(), state);
    const s = server;
    await waitFor("ready server", 60_000, async () => {
      try {
        return (await fetch(`${s.base}/auth/health`)).status === 200;
      } catch {
        return false;
      }
    });
    const users = await makeUsers(s);
    const ops = operations(s, users);
    const results: PerformanceData["operations"] = [];
    const measured = new Map<string, { route: string; clientMs: number }>();
    for (const route of MEASURED_ROUTES) {
      const op = ops[route];
      for (let n = 0; n < WARMUP + SAMPLES; n++) {
        const r = await op(n);
        // A measured call is the operation itself: a refusal is another path.
        if (r.status < 200 || r.status > 299)
          throw new Error(`${route}: call ${n} answered ${r.status}: ${r.body}`);
        if (r.trace === "") throw new Error(`${route}: call ${n} has no trace header`);
        if (n >= WARMUP) measured.set(r.trace, { route, clientMs: r.ms });
      }
    }
    // The events flush after each answer, so the last lines can come late.
    const serverOf = new Map<string, number>();
    await waitFor("request event of each measured call", 30_000, () => {
      for (const l of s.lines) if (l.kind === "request") serverOf.set(l.traceId, l.durationMs);
      return [...measured.keys()].every((t) => serverOf.has(t));
    });
    for (const route of MEASURED_ROUTES) {
      const calls = [...measured.entries()].filter(([, v]) => v.route === route);
      const server = calls.map(([t]) => serverOf.get(t) ?? Number.NaN);
      const client = calls.map(([, v]) => v.clientMs);
      results.push({
        route,
        samples: calls.length,
        serverMs: spread(server),
        clientMs: spread(client),
      });
    }
    await stopServer(s);
    const after = os.loadavg() as [number, number, number];
    const cpu = os.cpus()[0]?.model ?? "";
    const data: PerformanceData = {
      measuredAt: new Date().toISOString(),
      commit,
      machine: {
        os: os.type(),
        release: os.release(),
        cpu,
        cores,
        memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      },
      load: { before, after },
      runtime: { wrangler: wranglerVersion, workerd: "local", node: process.versions.node },
      storage: "d1-local",
      pbkdf2Iterations: PBKDF2_ITERATIONS,
      warmup: WARMUP,
      operations: results,
    };
    writeFileSync(`${SITE}${PERFORMANCE_DATA}`, `${JSON.stringify(data, null, 2)}\n`);
    const pagePath = `${DOCS}${PERFORMANCE_PAGE}`;
    const page = readFileSync(pagePath, "utf8");
    const from = page.indexOf(MEASURED_START);
    const to = page.indexOf(MEASURED_END);
    if (from < 0 || to < from)
      throw new Error(`measure-performance: ${PERFORMANCE_PAGE} has no markers`);
    writeFileSync(
      pagePath,
      `${page.slice(0, from + MEASURED_START.length)}\n${renderPerformanceTable(data)}\n${page.slice(to)}`,
    );
    console.log(
      `measure-performance: PASS operations=${results.length} samples=${measured.size} load-before=${before[0]} load-after=${after[0]}`,
    );
  } catch (e) {
    if (server) {
      console.error(server.output.slice(-40).join("\n"));
      await stopServer(server);
    }
    throw e;
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

await main();
