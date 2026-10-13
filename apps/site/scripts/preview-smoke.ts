// Review Focus 1 of plan 11a: the Worker answers a URL with no trailing slash
// and a missing page the way a reader expects. It runs `wrangler dev` on the
// built dist and makes five requests. It is not part of `pnpm test`, because
// wrangler dev takes seconds to start; Task 14 of plan 11a runs it.
import { spawn } from "node:child_process";
import { SITE } from "./lib/paths.ts";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

const dev = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(PORT)],
  {
    cwd: SITE,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    stdio: "ignore",
  },
);

async function ready(): Promise<void> {
  for (let i = 0; i < 120; i++) {
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
    res.status === 200 && body.includes("Read the docs") ? null : `status ${res.status}`,
  );
  await expectAnswer("/docs/", (res) => (res.status === 200 ? null : `status ${res.status}`));
  await expectAnswer("/docs", (res) =>
    (res.status === 307 || res.status === 308) && res.headers.get("location") === "/docs/"
      ? null
      : `status ${res.status}, location ${res.headers.get("location")}`,
  );
  await expectAnswer("/docs/no-such-page/", (res, body) =>
    res.status === 404 && body.includes("404") ? null : `status ${res.status}`,
  );
  await expectAnswer("/pagefind/pagefind.js", (res) =>
    res.status === 200 ? null : `status ${res.status}`,
  );
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  dev.kill("SIGTERM");
}
console.log(
  `preview-smoke: ${failures.length === 0 ? "PASS" : "FAIL"} checks=${checks} failures=${failures.length}`,
);
for (const f of failures) console.error(`preview-smoke: ${f}`);
if (failures.length > 0) process.exit(1);
