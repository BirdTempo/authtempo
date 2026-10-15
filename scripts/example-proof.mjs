// The proof of a built example app (plan 11d2): run five checks over the
// app's own server and print one summary line. Two modes, one check list:
//   node scripts/example-proof.mjs <label> <port> <command> [args…]
//     starts the built server on the port (Astro, SvelteKit, Nuxt, Solid Start);
//   node scripts/example-proof.mjs <label> <port> --module <file>
//     imports a built server module whose default export is { fetch }, and
//     calls it in process (TanStack Start). The port only names the origin.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [label, portText, command, ...args] = process.argv.slice(2);
if (!label || !portText || !command) {
  console.error(
    "usage: node scripts/example-proof.mjs <label> <port> <command> [args…] | --module <file>",
  );
  process.exit(2);
}
const PORT = Number(portText);
const BASE = `http://127.0.0.1:${PORT}`;
// The default session cookie of core (plan 12b). The proof sends it back in a
// Cookie header, so the Secure flag does not stop it over plain HTTP.
const SESSION_COOKIE = "__Host-tempo_session";
const ENV = {
  HOST: "127.0.0.1",
  PORT: String(PORT),
  NITRO_HOST: "127.0.0.1",
  NITRO_PORT: String(PORT),
  BASE_URL: BASE,
  AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  // The example keeps the last mailed link for /test-only/last-link. A deploy never sets it.
  TEST_MODE: "1",
};
let log = "";
let server = null;
/** The fetch of the checks: over HTTP to the started server, or to the module in process. */
let fetch = globalThis.fetch;
if (command === "--module") {
  const file = args[0];
  if (!file) {
    console.error(`${label}: --module needs the path of the built server module`);
    process.exit(2);
  }
  Object.assign(process.env, ENV);
  const mod = await import(pathToFileURL(resolve(file)).href);
  const handler = mod.default?.fetch;
  if (typeof handler !== "function") {
    console.error(`${label}: ${file} has no default export with a fetch function`);
    process.exit(1);
  }
  fetch = (input, init) => handler(new Request(input, init));
} else {
  server = spawn(command, args, {
    env: { ...process.env, ...ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => {
    log += d;
  });
  server.stderr.on("data", (d) => {
    log += d;
  });
}

const failures = [];
let checks = 0;
const expectThat = (ok, what) => {
  checks++;
  if (!ok) failures.push(what);
};
const post = (path, body, cookie = "") =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${BASE}/auth/session`).then(
      () => true,
      () => false,
    );
  }
  if (!up) throw new Error("the server did not answer in 30 s");
  const session = await fetch(`${BASE}/auth/session`);
  expectThat(session.status === 401, `GET /auth/session answered ${session.status}`);
  const away = await fetch(`${BASE}/account`, { redirect: "manual" });
  expectThat(
    away.status === 307 && away.headers.get("location")?.endsWith("/sign-in?next=%2Faccount"),
    `GET /account answered ${away.status} to ${away.headers.get("location")}`,
  );
  await post("/auth/magic-link/request", { email: "ada@example.com" });
  const { link } = await (await fetch(`${BASE}/test-only/last-link`)).json();
  const token = new URL(link ?? "http://x/").searchParams.get("token") ?? "";
  const verified = await post("/auth/magic-link/verify", { token });
  const cookie = (verified.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  expectThat(
    cookie.startsWith(`${SESSION_COOKIE}=ts_`),
    `the verify set no session cookie (${verified.status})`,
  );
  const home = await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
  expectThat(home.includes("ada@example.com"), "the home page does not show the person");
  const account = await fetch(`${BASE}/account`, { redirect: "manual", headers: { cookie } });
  expectThat(
    account.status === 200 && (await account.text()).includes("ada@example.com"),
    `GET /account with the cookie answered ${account.status}`,
  );
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  server?.kill("SIGTERM");
}
const pass = failures.length === 0 && checks === 5;
console.log(`${label}: ${pass ? "PASS" : "FAIL"} checks=${checks} failures=${failures.length}`);
for (const f of failures) console.error(`${label}: ${f}`);
if (!pass) {
  console.error(log);
  process.exit(1);
}
// A server module may keep a timer open; the proof is over.
process.exit(0);
