// Review Focus 1 of plan 11a: the Worker answers a URL with no trailing slash
// and a missing page the way a reader expects. It runs `wrangler dev` on the
// built dist and makes five requests. It is not part of `pnpm test`, because
// wrangler dev takes seconds to start; Task 14 of plan 11a runs it.
import { spawn } from "node:child_process";
import { SITE } from "./lib/paths.ts";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

// SMOKE_WRANGLER_ARGS replaces the wrangler arguments. Only the proof of this
// script's failure path uses it (a wrong argument must fail at once).
const wranglerArgs = process.env.SMOKE_WRANGLER_ARGS?.split(" ") ?? [
  "dev",
  "--ip",
  "127.0.0.1",
  "--port",
  String(PORT),
];

// A server already on the port is a stale wrangler from an earlier run, and
// the checks below would read its old content. Fail before the spawn.
const stale = await fetch(`${BASE}/`).then(
  () => true,
  () => false,
);
if (stale) {
  console.error(`preview-smoke: FAIL port ${PORT} already answers; stop that server first`);
  process.exit(1);
}

// detached: the child leads its own process group, so one kill ends pnpm,
// wrangler, and workerd. Without it workerd outlives the run.
const dev = spawn("pnpm", ["exec", "wrangler", ...wranglerArgs], {
  cwd: SITE,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
});

let stderrTail = "";
dev.stderr.on("data", (chunk: Buffer) => {
  stderrTail = (stderrTail + chunk.toString()).split("\n").slice(-15).join("\n");
});
let exited: string | null = null;
dev.on("exit", (code, signal) => {
  exited = `wrangler dev exited (code ${code}, signal ${signal}): ${stderrTail.trim()}`;
});

function killGroup(): void {
  try {
    if (dev.pid !== undefined) process.kill(-dev.pid, "SIGTERM");
  } catch {
    // The group is already gone.
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    killGroup();
    process.exit(130);
  });

async function ready(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error(exited);
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("wrangler dev did not answer within 60 s");
}

const failures: string[] = [];
let checks = 0;
async function expectAnswer(path: string, test: (res: Response, body: string) => string | null) {
  checks++;
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const problem = test(res, await res.text());
  if (problem) failures.push(`${path}: ${problem}`);
}

try {
  await ready();
  await expectAnswer("/", (res, body) =>
    res.status !== 200
      ? `status ${res.status}`
      : body.includes("Read the docs")
        ? null
        : 'status 200 but the body lacks "Read the docs"',
  );
  await expectAnswer("/docs/", (res) => (res.status === 200 ? null : `status ${res.status}`));
  await expectAnswer("/docs", (res) =>
    (res.status === 307 || res.status === 308) && res.headers.get("location") === "/docs/"
      ? null
      : `status ${res.status}, location ${res.headers.get("location")}`,
  );
  await expectAnswer("/docs/no-such-page/", (res, body) =>
    res.status !== 404
      ? `status ${res.status}`
      : body.includes("404")
        ? null
        : 'status 404 but the body lacks "404"',
  );
  await expectAnswer("/pagefind/pagefind.js", (res) =>
    res.status === 200 ? null : `status ${res.status}`,
  );
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  killGroup();
}
console.log(
  `preview-smoke: ${failures.length === 0 ? "PASS" : "FAIL"} checks=${checks} failures=${failures.length}`,
);
for (const f of failures) console.error(`preview-smoke: ${f}`);
if (failures.length > 0) process.exit(1);
