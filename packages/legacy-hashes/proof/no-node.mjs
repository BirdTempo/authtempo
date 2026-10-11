// The no-Node proof of @tempo-auth/legacy-hashes (plan 9b, spec 17.2).
//
// Why not a vitest pool test: @cloudflare/vitest-plugin 1.4.0 removes
// no_nodejs_compat_v2 and adds Node.js modules to the runner Worker
// (dist/pool/index.mjs, read 2026-10-11), so inside the pool a Worker has
// `process` and node:crypto whatever its flags say. wrangler's own dev
// runtime keeps the flags. This script starts proof/worker.ts there with
// no_nodejs_compat and no_nodejs_compat_v2, and fails unless every vector
// verifies, every wrong password fails, and the Worker sees no `process`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const config = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
// A Worker that imports a Node.js module does not start: workerd logs
// `No such module "node:crypto"`, and the fetch below never answers.
// Workerd gives no `process` with no_nodejs_compat_v2 alone, so the runtime
// check cannot see a missing no_nodejs_compat. Spec 17.6 names both flags, so
// the script reads the config and fails unless both are there.
const configText = readFileSync(config, "utf8");
for (const flag of ["no_nodejs_compat", "no_nodejs_compat_v2"]) {
  if (!new RegExp(`"${flag}"`).test(configText)) {
    console.error(`no-node proof: FAIL, proof/wrangler.jsonc does not set ${flag}`);
    process.exit(1);
  }
}
let worker;
const timer = setTimeout(() => {
  console.error("no-node proof: FAIL, no answer in 60 s; read the workerd error above");
  // Dispose first, so that a failed run leaves no workerd process behind.
  Promise.resolve(worker?.dispose()).finally(() => process.exit(1));
}, 60_000);
worker = await unstable_startWorker({
  config,
  dev: { server: { port: 0 }, inspector: false, logLevel: "error" },
});
let failed = false;
let count = 0;
try {
  const res = await worker.fetch("http://proof.local/");
  const body = await res.json();
  console.log(JSON.stringify(body));
  if (body.process !== "undefined" || body.Buffer !== "undefined") {
    console.error("no-node proof: FAIL, the Worker has Node.js globals, so the flags did not hold");
    failed = true;
  }
  for (const [name, r] of Object.entries(body.results ?? {})) {
    if (r.right !== true || r.wrong !== false) {
      console.error(`no-node proof: FAIL, vector ${name} answered ${JSON.stringify(r)}`);
      failed = true;
    }
  }
  // The vectors module owns the count; the Worker reports it as `expected`.
  count = Object.keys(body.results ?? {}).length;
  if (!(body.expected > 0) || count !== body.expected) {
    console.error(`no-node proof: FAIL, ${count} vectors answered, ${body.expected} expected`);
    failed = true;
  }
} finally {
  clearTimeout(timer);
  await worker.dispose();
}
if (failed) process.exit(1);
console.log(`no-node proof: PASS, ${count} vectors, no process global, no Node.js module`);
