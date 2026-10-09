// The plan 6c Electron proof on macOS. It delivers the handoff code to the running app two ways:
// (a) `open` of the app URL, which macOS sends to the running app as open-url;
// (b) a second launch of the binary with the URL in argv, which reaches the first app as second-instance.
// It also delivers a URL off the redirect, which the opener must drop.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, playBrowser, startWorker } from "../../worker/proof/dev.mjs";
import { buildBundle, deleteKeychainItem, unregisterBundle } from "./bundle.mjs";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG_DIR, "..", "..");
const EMAIL = "electron-proof@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proofDir = mkdtempSync(join(tmpdir(), "tempo-auth-electron-proof-"));
// LaunchServices marks an app in a temporary folder "launch-disabled in-temp-dir" and binds no
// URL scheme to it: `open` then fails with -10814 (lsregister -dump, macOS 27.0, 2026-10-10).
// So the bundle lives in the package folder, which .gitignore excludes, and the run removes it.
const bundleDir = mkdtempSync(join(PKG_DIR, ".proof-bundle-"));
// The failure text of `open` holds the URL. The record must not hold a handoff code.
const scrub = (text) => text.replace(/hc_[A-Za-z0-9_-]+/g, "hc_<redacted>");
const eventsFile = join(proofDir, "events.jsonl");
const events = () =>
  existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
// The app log never holds the code (Task 3). It keeps the route and the code length, so the
// proof matches a delivery on the same two values of the URL it sent.
const redacted = (url) => {
  const [route = "", query = ""] = url.split("?", 2);
  return { url: route, codeLength: new URLSearchParams(query).get("code")?.length };
};
const delivered = (x, url) => {
  const want = redacted(url);
  return x.received?.url === want.url && x.received?.codeLength === want.codeLength;
};
async function waitFor(label, pick, ms = 30_000) {
  for (let i = 0; i < ms / 200; i++) {
    const found = pick(events());
    if (found) return found;
    await sleep(200);
  }
  throw new Error(`timed out: ${label}; read ${eventsFile}`);
}
const failures = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
};

const macOS = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
let first = null;
let second = null;
let bundle = null;
let worker = null;
let electron = null;
try {
  // Turbo runs from the root: turbo is a root devDependency. --force: the proof reads dist/main.js,
  // so the build must be newer than the source, never a cache replay.
  execFileSync(
    "pnpm",
    ["exec", "turbo", "run", "build", "--force", "--filter=tempo-auth-example-electron..."],
    { cwd: ROOT, stdio: "inherit" },
  );
  deleteKeychainItem();
  worker = await startWorker();
  bundle = buildBundle(bundleDir);
  const env = { ...process.env, PROOF_DIR: proofDir, PROOF_ROUNDS: "2", EXAMPLE_API_URL: BASE };
  const out = openSync(join(proofDir, "electron.log"), "w");
  first = spawn(bundle.exe, [], { env, stdio: ["ignore", out, out] });
  const started = await waitFor("started", (e) => e.find((x) => x.event === "started"));
  electron = started.electron;
  const firstPid = started.pid;

  // Round 1: open-url.
  const start1 = await waitFor(
    "round 1 start URL",
    (e) => e.filter((x) => x.event === "open-external")[0],
  );
  const url1 = await playBrowser(start1.url, EMAIL);
  check("round 1 app URL is on the redirect", url1.startsWith("example-app://auth?code=hc_"));
  // Break proof inside the run: the same code on another route. The opener must drop it.
  const wrong = url1.replace("example-app://auth?", "example-app://other?");
  execFileSync("open", [wrong]);
  await waitFor("open-url of the wrong URL", (e) =>
    e.find((x) => x.event === "open-url" && delivered(x, wrong)),
  );
  await sleep(1000);
  check(
    "the wrong URL did not end the wait",
    !events().some((x) => x.event === "sign-in-failed" || x.event === "signed-in"),
  );
  execFileSync("open", [url1]);
  const openUrl = await waitFor("open-url of round 1", (e) =>
    e.find((x) => x.event === "open-url" && delivered(x, url1)),
  );
  check("open-url reached the first instance", openUrl.pid === firstPid);
  const s1 = await waitFor("signed-in round 1", (e) =>
    e.find((x) => x.event === "signed-in" && x.round === 1),
  );

  // Round 2: second-instance.
  const start2 = await waitFor(
    "round 2 start URL",
    (e) => e.filter((x) => x.event === "open-external")[1],
  );
  const url2 = await playBrowser(start2.url, EMAIL);
  second = spawn(bundle.exe, [url2], { env, stdio: "ignore" });
  // If the first instance is gone, the second one gets the lock, starts a sign-in, and never
  // exits. The limit turns that hang into a failure (break proof of the wrong-URL check, 2026-10-10).
  const secondExit = await new Promise((r) => {
    const timer = setTimeout(() => r("no exit in 30 s"), 30_000);
    second.on("exit", (code) => {
      clearTimeout(timer);
      r(code);
    });
  });
  check("the second instance exited 0", secondExit === 0);
  const si = await waitFor("second-instance", (e) =>
    e.find((x) => x.event === "second-instance" && delivered(x, url2)),
  );
  check("second-instance reached the first instance", si.pid === firstPid);
  const s2 = await waitFor("signed-in round 2", (e) =>
    e.find((x) => x.event === "signed-in" && x.round === 2),
  );
  await waitFor("done", (e) => e.find((x) => x.event === "done"));

  for (const [name, s] of [
    ["round 1", s1],
    ["round 2", s2],
  ]) {
    check(`${name} signed in the proof address`, s.email === EMAIL);
    check(`${name} store answers the token`, s.storedMatches === true);
    check(`${name} token is not plaintext on disk`, s.plaintextOnDisk === false);
    check(`${name} /me answers 200`, s.meStatus === 200);
    check(`${name} /me answers the user`, s.meEmail === EMAIL);
    check(`${name} client session answers the user`, s.sessionEmail === EMAIL);
    check(`${name} ran in the first instance`, s.pid === firstPid);
  }
  check(
    "no sign-in failed",
    !events().some((x) => x.event === "sign-in-failed" || x.event === "crashed"),
  );
  check("token.bin exists", existsSync(join(proofDir, "user-data", "token.bin")));
} catch (e) {
  failures.push(scrub(String(e)));
} finally {
  if (first && first.exitCode === null) first.kill();
  if (second && second.exitCode === null) second.kill();
  await worker?.stop();
  if (bundle) unregisterBundle(bundle.app);
  rmSync(bundleDir, { recursive: true, force: true });
  deleteKeychainItem();
}
console.log(
  JSON.stringify({
    proof: "electron-open-url-second-instance",
    result: failures.length === 0 ? "pass" : "fail",
    date: new Date().toISOString(),
    macOS,
    electron,
    failures,
    events: eventsFile,
  }),
);
process.exit(failures.length === 0 ? 0 : 1);
