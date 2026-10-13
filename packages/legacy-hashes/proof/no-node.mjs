// The no-Node proof of @authtempo/legacy-hashes (plan 9b, spec 17.2).
//
// Why not a vitest pool test: @cloudflare/vitest-plugin 1.4.0 removes
// no_nodejs_compat_v2 and adds Node.js modules to the runner Worker
// (dist/pool/index.mjs, read 2026-10-11), so inside the pool a Worker has
// `process` and node:crypto whatever its flags say. wrangler's own dev
// runtime keeps the flags. This script starts proof/worker.ts there with
// no_nodejs_compat and no_nodejs_compat_v2, and fails unless every vector
// verifies, every wrong password fails, and the Worker sees no `process`.
import { fileURLToPath } from "node:url";
import { unstable_readConfig, unstable_startWorker } from "wrangler";

const config = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
// A Worker that imports a Node.js module does not start: workerd logs
// `No such module "node:crypto"`, and the fetch below never answers.
// Workerd gives no `process` with no_nodejs_compat_v2 alone, so the runtime
// check cannot see a missing no_nodejs_compat. Spec 17.6 names both flags, so
// the script reads the parsed config (wrangler's own reader, so a flag in a
// comment does not count) and fails unless both are there.
const flags = unstable_readConfig({ config }).compatibility_flags ?? [];
for (const flag of ["no_nodejs_compat", "no_nodejs_compat_v2"]) {
  if (!flags.includes(flag)) {
    console.error(`no-node proof: FAIL, proof/wrangler.jsonc does not set ${flag}`);
    process.exit(1);
  }
}
// test/vectors.ts holds 6 vectors (bcrypt 2a and 2b, argon2id, pbkdf2,
// scrypt, firescrypt), counted 2026-10-11. The Worker reports the count from
// the same module, so a shrunken VECTORS would pass the equality check
// below. This floor makes it fail. Raise it when a vector is added.
const MIN_VECTORS = 6;
// A hung dispose must not hold the exit: the timeout path gives it 10 s.
const DISPOSE_LIMIT_MS = 10_000;
let worker;
const timer = setTimeout(() => {
  console.error("no-node proof: FAIL, no answer in 60 s; read the workerd error above");
  // Dispose first, so that a failed run leaves no workerd process behind.
  // A hung dispose gets its own limit, so the script still exits.
  const limit = new Promise((resolve) => setTimeout(resolve, DISPOSE_LIMIT_MS));
  Promise.race([Promise.resolve(worker?.dispose()), limit]).finally(() => process.exit(1));
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
  if (!(body.expected >= MIN_VECTORS) || count !== body.expected) {
    console.error(
      `no-node proof: FAIL, ${count} vectors answered, ${body.expected} expected, at least ${MIN_VECTORS}`,
    );
    failed = true;
  }
} finally {
  clearTimeout(timer);
  await worker.dispose();
}
if (failed) process.exit(1);
console.log(`no-node proof: PASS, ${count} vectors, no process global, no Node.js module`);
