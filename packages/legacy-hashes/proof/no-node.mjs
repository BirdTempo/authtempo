// The no-Node proof of @tempo-auth/legacy-hashes (plan 9b, spec 17.2).
//
// Why not a vitest pool test: @cloudflare/vitest-plugin 1.4.0 removes
// no_nodejs_compat_v2 and adds Node.js modules to the runner Worker
// (dist/pool/index.mjs, read 2026-10-11), so inside the pool a Worker has
// `process` and node:crypto whatever its flags say. wrangler's own dev
// runtime keeps the flags. This script starts proof/worker.ts there with
// no_nodejs_compat and no_nodejs_compat_v2, and fails unless every vector
// verifies, every wrong password fails, and the Worker sees no `process`.
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const config = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
// A Worker that imports a Node.js module does not start: workerd logs
// `No such module "node:crypto"`, and the fetch below never answers.
const timer = setTimeout(() => {
  console.error("no-node proof: FAIL, no answer in 60 s; read the workerd error above");
  process.exit(1);
}, 60_000);
const worker = await unstable_startWorker({
  config,
  dev: { server: { port: 0 }, inspector: false, logLevel: "error" },
});
let failed = false;
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
  if (Object.keys(body.results ?? {}).length !== 6) {
    console.error("no-node proof: FAIL, expected 6 vectors");
    failed = true;
  }
} finally {
  clearTimeout(timer);
  await worker.dispose();
}
if (failed) process.exit(1);
console.log("no-node proof: PASS, 6 vectors, no process global, no Node.js module");
