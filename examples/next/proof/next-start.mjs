// The Next.js example under the real server (plan 11d): a build with the
// proof's mail route, `next start`, seven checks over HTTP (three signed out,
// four through a sign-in), and one summary line. The route lives in
// proof/mail-route.ts. This script copies it into the app for its own build
// and deletes it after, so the example app never ships it; the test script
// then builds the app again without it. Port 8793: the Node example uses 8791
// and 8792.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const routeDir = fileURLToPath(new URL("../app/proof", import.meta.url));
const failures = [];
let checks = 0;
const expectThat = (ok, what) => {
  checks++;
  if (!ok) failures.push(what);
};
let log = "";
let server = null;

try {
  mkdirSync(`${routeDir}/mail`, { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("mail-route.ts", import.meta.url)),
    `${routeDir}/mail/route.ts`,
  );
  const build = spawnSync("pnpm", ["exec", "next", "build"], {
    cwd,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
  });
  if (build.status !== 0)
    throw new Error(`next build with the proof route failed:\n${build.stdout}${build.stderr}`);
  server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      BASE_URL: BASE,
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      // The route app/proof/mail answers only with this variable: on for this proof only.
      AUTHTEMPO_PROOF_MAIL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => {
    log += d;
  });
  server.stderr.on("data", (d) => {
    log += d;
  });
  // The first answer of the proof route arms its mail sink: it makes the app's
  // one auth instance before any page or route can make it with no sink.
  let armed = null;
  for (let i = 0; i < 60 && armed === null; i++) {
    await new Promise((r) => setTimeout(r, 500));
    armed = await fetch(`${BASE}/proof/mail`).then(
      async (r) => (r.ok ? (await r.json()).armed : `status ${r.status}`),
      () => null,
    );
  }
  if (armed === null) throw new Error("next start did not answer in 30 s");
  if (armed !== true) throw new Error(`the proof route did not arm its mail sink (${armed})`);
  const session = await fetch(`${BASE}/auth/session`);
  expectThat(session.status === 401, `GET /auth/session answered ${session.status}`);
  const account = await fetch(`${BASE}/account`, { redirect: "manual" });
  expectThat(
    account.status === 307 && account.headers.get("location")?.endsWith("/sign-in?next=%2Faccount"),
    `GET /account answered ${account.status} to ${account.headers.get("location")}`,
  );
  const home = await (await fetch(`${BASE}/`)).text();
  expectThat(home.includes("Sign in"), "the home page has no sign-in link");

  // Sign in over HTTP, then the server components read the session from the cookie.
  const post = (path, body) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    });
  const requested = await post("/auth/magic-link/request", { email: "ada@example.com" });
  expectThat(requested.ok, `POST /auth/magic-link/request answered ${requested.status}`);
  // The token stays in this process: it is never printed.
  const mailed = (await (await fetch(`${BASE}/proof/mail`)).json()).text ?? "";
  const token = /token=([A-Za-z0-9_-]+)/.exec(mailed)?.[1] ?? "";
  const verified = await post("/auth/magic-link/verify", { token });
  const cookie = (verified.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expectThat(
    verified.ok && cookie.includes("=ts_"),
    `POST /auth/magic-link/verify answered ${verified.status}`,
  );
  // React puts a comment between two text parts; the reader sees one line.
  const text = async (res) => (await res.text()).replaceAll("<!-- -->", "");
  const signedHome = await text(await fetch(`${BASE}/`, { headers: { cookie } }));
  expectThat(signedHome.includes("Signed in as ada@example.com"), "the home page shows no session");
  const signedAccount = await fetch(`${BASE}/account`, { headers: { cookie }, redirect: "manual" });
  const accountText = await text(signedAccount);
  expectThat(
    signedAccount.status === 200 && accountText.includes("Your account: ada@example.com"),
    `GET /account with the cookie answered ${signedAccount.status} with no account line`,
  );
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  server?.kill("SIGTERM");
  // The example app never keeps the proof route.
  rmSync(routeDir, { recursive: true, force: true });
}
const pass = failures.length === 0 && checks === 7;
console.log(`next-e2e: ${pass ? "PASS" : "FAIL"} checks=${checks} failures=${failures.length}`);
for (const f of failures) console.error(`next-e2e: ${f}`);
if (!pass) {
  console.error(log);
  process.exit(1);
}
