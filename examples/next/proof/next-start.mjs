// The Next.js example under the real server (plan 11d): `next start` of the
// build, seven checks over HTTP (three signed out, four through a sign-in),
// and one summary line. The test script runs it
// after `next build`. Port 8793: the Node example uses 8791 and 8792.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    BASE_URL: BASE,
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    // The mail sink of lib/auth.ts and the route app/proof/mail: on for this proof only.
    AUTHTEMPO_PROOF_MAIL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => {
  log += d;
});
server.stderr.on("data", (d) => {
  log += d;
});

const failures = [];
let checks = 0;
const expectThat = (ok, what) => {
  checks++;
  if (!ok) failures.push(what);
};
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${BASE}/`).then(
      () => true,
      () => false,
    );
  }
  if (!up) throw new Error("next start did not answer in 30 s");
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
  server.kill("SIGTERM");
}
const pass = failures.length === 0 && checks === 7;
console.log(`next-e2e: ${pass ? "PASS" : "FAIL"} checks=${checks} failures=${failures.length}`);
for (const f of failures) console.error(`next-e2e: ${f}`);
if (!pass) {
  console.error(log);
  process.exit(1);
}
