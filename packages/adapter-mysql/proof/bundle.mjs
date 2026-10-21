// The bundle proof of the MySQL adapter on Workers (plan 12g, Task 5). It
// bundles proof/worker with wrangler (a dry run, no deploy) and fails when
// the bundle imports a Node module that nodejs_compat does not serve. Then it
// runs the Worker in workerd through wrangler dev and reads its answer. A
// deployed run through Hyperdrive is an owner item.
//
// The plan put the workerd run in a vitest pool test. @cloudflare/vitest-plugin
// 1.4.0 loads mysql2 through its own module fallback. That fallback has no
// node:process (2026-10-21), with or without the dependency optimizer.
// wrangler dev runs the bundle that wrangler makes, as a deploy does.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The modules that nodejs_compat serves in full or in part, read on
 * developers.cloudflare.com/workers/runtime-apis/nodejs/ on 2026-10-21.
 * A subpath such as stream/web or fs/promises counts under its module. The
 * page lists the other modules as stubs that do not work, so they are not
 * here. They are http2, vm, cluster, domain, trace_events, wasi, dgram,
 * inspector, sqlite, child_process, readline, repl, tty, v8, and
 * worker_threads.
 */
const SERVED = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "console",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "stream",
  "string_decoder",
  "test",
  "timers",
  "tls",
  "url",
  "util",
  "zlib",
]);

const worker = fileURLToPath(new URL("worker", import.meta.url));
// The four keys of ruling 40 of plan 11e: the banner's npm update check can hold the child.
const ENV = {
  ...process.env,
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
  WRANGLER_HIDE_BANNER: "true",
};

/** A port that the OS gives free, closed again for wrangler dev (the ports rule of 2026-10-20). */
async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  await new Promise((r) => server.close(r));
  return typeof address === "object" && address ? address.port : 0;
}

/** The answer of the Worker in workerd: wrangler dev, then GET / until it answers, for at most 60 s. */
async function workerdAnswer() {
  const port = await freePort();
  const dev = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--ip", "127.0.0.1", "--port", String(port)],
    {
      cwd: worker,
      env: ENV,
      detached: true,
      stdio: "ignore",
    },
  );
  try {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return `${res.status} ${await res.text()}`;
      } catch {
        // Not up yet.
      }
    }
    return "no answer in 60 s";
  } finally {
    // wrangler starts workerd as a child, so the signal goes to the group.
    try {
      process.kill(-(dev.pid ?? 0), "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}
const out = mkdtempSync(join(tmpdir(), "authtempo-bundle-mysql-"));
try {
  const run = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out], {
    encoding: "utf8",
    cwd: worker,
    env: ENV,
  });
  const failures = [];
  if (run.status !== 0) failures.push(`wrangler exited ${run.status}`);
  // Count what was scanned: a bundle in another file name must not pass unseen.
  const files = readdirSync(out).filter((n) => /\.m?js$/.test(n));
  if (!files.includes("index.js")) failures.push("index.js is not in the output");
  const modules = new Set();
  let bytes = 0;
  for (const f of files) {
    bytes += statSync(join(out, f)).size;
    const text = readFileSync(join(out, f), "utf8");
    for (const m of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:node:)?([a-z_]+)(?:\/[a-z_/]+)?["']/g,
    )) {
      const name = m[1];
      // A bare name that is no Node module is a bundled package, not an import.
      if (name !== undefined && (m[0].includes("node:") || builtinModules.includes(name)))
        modules.add(name);
    }
  }
  for (const m of modules)
    if (!SERVED.has(m))
      failures.push(`the bundle imports node:${m}, which nodejs_compat does not serve`);
  // The proof Worker answers the type of the adapter's findOne.
  const answer = failures.length === 0 ? await workerdAnswer() : "not run";
  if (answer !== "200 function") failures.push(`workerd answered ${answer}, not 200 function`);
  if (failures.length > 0) {
    console.error(`${run.stdout}\n${run.stderr}`);
    console.error(`bundle-mysql: FAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(
    `bundle-mysql: PASS bytes=${bytes} node=${[...modules].sort().join(",")} workerd=${answer}`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
