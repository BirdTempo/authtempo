// The shared kit for the plan 6c device proofs. It starts the example Worker under
// `wrangler dev` on a fresh local D1, and plays the browser part of a handoff over HTTP
// with the same requests as test/handoff.e2e.test.ts. A proof that needs a real browser
// drives one itself.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "http://localhost:8787";
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answers(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

export async function startWorker() {
  if (await answers(BASE))
    throw new Error(`port 8787 answers already; stop the other wrangler dev first`);
  const persist = mkdtempSync(join(tmpdir(), "tempo-auth-proof-d1-"));
  // CI=1 makes wrangler skip its confirm prompt.
  const env = { ...process.env, CI: "1" };
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
    { cwd: WORKER_DIR, env, stdio: "inherit" },
  );
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
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${BASE}/__test/last-link`);
      if (r.status === 200) return { persist, logFile, stop };
    } catch {}
    await sleep(200);
  }
  stop();
  throw new Error(`wrangler dev did not answer in 60 s; read ${logFile}`);
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
  const start = await fetch(startUrl, { redirect: "manual" });
  expectStatus(start, 200, "GET /auth/handoff/start");
  const cont = /data-continue="([^"]+)"/.exec(await start.text())?.[1];
  if (!cont?.startsWith("/auth/handoff/continue?h=hs_"))
    throw new Error("no continue path on the start page");
  const req = await fetch(`${BASE}/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, next: cont }),
  });
  expectStatus(req, 200, "POST /auth/magic-link/request");
  const { link } = await (await fetch(`${BASE}/__test/last-link`)).json();
  // This proves that --var BASE_URL took effect: core builds the link from baseURL.
  if (!link?.startsWith(`${BASE}/`)) throw new Error(`the magic link ${link} is not on ${BASE}`);
  const token = new URL(link).searchParams.get("token") ?? "";
  const verify = await fetch(`${BASE}/auth/magic-link/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ token }).toString(),
  });
  expectStatus(verify, 302, "POST /auth/magic-link/verify");
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const confirm = await fetch(`${BASE}${cont}`, { redirect: "manual", headers: { cookie } });
  expectStatus(confirm, 200, "GET the continue path");
  const h = new URL(`${BASE}${cont}`).searchParams.get("h") ?? "";
  const next = await fetch(`${BASE}/auth/handoff/continue`, {
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
  const redeem = await fetch(`${BASE}/auth/handoff/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  expectStatus(redeem, 200, "POST /auth/handoff/redeem");
  return (await redeem.json()).token;
}
