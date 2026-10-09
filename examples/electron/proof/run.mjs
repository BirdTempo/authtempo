// The plan 6c Electron proof on macOS. It delivers the handoff code to the running app two ways:
// (a) `open` of the app URL, which macOS sends to the running app as open-url;
// (b) a second launch of the binary with the URL in argv, which reaches the first app as second-instance.
// It also delivers a URL off the redirect, which the opener must drop.
// Each pass writes its JSON line to results/electron-macos-<date>.json, a new file each time. It
// never overwrites a file: results/electron-macos.json is the committed record of the first pass.
// After the cleanup, the result notes whether LaunchServices still keeps a handler preference for
// example-app. Unregistering the bundle does not remove it (macOS 27.0, 2026-10-10).
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, playBrowser, startWorker } from "../../worker/proof/dev.mjs";
import { buildBundle, deleteKeychainItem, handlerPreference, unregisterBundle } from "./bundle.mjs";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG_DIR, "..", "..");
const EMAIL = "electron-proof@example.com";
const BUNDLE_PREFIX = ".proof-bundle-";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A run that ended on a signal can leave a registered bundle. Two registered bundles claim
// example-app, and `open` can then start the stale copy. So remove every old one first.
// The unregister error is ignored here: a stale folder may never have been registered.
for (const name of readdirSync(PKG_DIR)) {
  if (!name.startsWith(BUNDLE_PREFIX)) continue;
  unregisterBundle(join(PKG_DIR, name, "TempoAuthExample.app"));
  rmSync(join(PKG_DIR, name), { recursive: true, force: true });
}

const proofDir = mkdtempSync(join(tmpdir(), "tempo-auth-electron-proof-"));
// LaunchServices marks an app in a temporary folder "launch-disabled in-temp-dir" and binds no
// URL scheme to it: `open` then fails with -10814 (lsregister -dump, macOS 27.0, 2026-10-10).
// So the bundle lives in the package folder, which .gitignore excludes, and the run removes it.
const bundleDir = mkdtempSync(join(PKG_DIR, BUNDLE_PREFIX));
// The record must not hold a handoff code. Every failure text goes through this.
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
// `open` writes the whole URL to stderr when it fails. The pipe keeps that text out of the
// terminal, and the error names only the route and the code length.
function openUrl(url) {
  try {
    execFileSync("open", [url], { stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
  } catch (e) {
    const { url: route, codeLength } = redacted(url);
    const why = scrub(String(e.stderr ?? "").trim()) || String(e.code ?? e.signal ?? e.status);
    throw new Error(`open of ${route} (code length ${codeLength}) failed: ${why}`);
  }
}
const failures = [];
const notes = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
};

let first = null;
let second = null;
let bundle = null;
let worker = null;
let electron = null;

// Sends SIGTERM, waits at most 5 s for the exit, then SIGKILL. The app must be gone before the
// cleanup deletes its bundle and its Keychain item, or it can write the item again.
async function stopApp(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  const timer = (ms) => sleep(ms).then(() => "timeout");
  if ((await Promise.race([exited, timer(5_000)])) === "timeout") {
    child.kill("SIGKILL");
    await Promise.race([exited, timer(2_000)]);
  }
}
// Runs one cleanup step. A step error goes into `failures` and never skips the steps after it.
async function cleanupStep(label, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push(`cleanup, ${label}: ${scrub(String(e))}`);
  }
}
function cleanupStepSync(label, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`cleanup, ${label}: ${scrub(String(e))}`);
  }
}
// The sync part of the cleanup, safe to call twice. A signal handler can run only sync code.
// The bundle is unregistered before its folder is removed, so LaunchServices keeps no record of
// a bundle that is gone.
let cleanedUp = false;
function cleanupSync() {
  if (cleanedUp) return;
  cleanedUp = true;
  cleanupStepSync("kill the app", () => {
    for (const child of [first, second]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
  cleanupStepSync("unregister the bundle", () => {
    const error = bundle ? unregisterBundle(bundle.app) : null;
    if (error) throw new Error(error);
  });
  cleanupStepSync("remove the bundle", () =>
    rmSync(bundleDir, { recursive: true, force: true, maxRetries: 3 }),
  );
  cleanupStepSync("delete the Keychain items", deleteKeychainItem);
}
// Ctrl-C or SIGTERM skips `finally`. This handler is added before startWorker adds the kit's
// handler, so it runs first. process.exit then runs the kit's exit handler, which stops the Worker.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    try {
      cleanupSync();
    } finally {
      process.exit(code);
    }
  });
}

const macOS = execFileSync("sw_vers", ["-productVersion"], {
  encoding: "utf8",
  timeout: 15_000,
}).trim();
try {
  // Turbo runs from the root: turbo is a root devDependency. --force: the proof reads dist/main.js,
  // so the build must be newer than the source, never a cache replay. The build of four packages
  // takes about 10 s; 5 min allows a loaded machine.
  execFileSync(
    "pnpm",
    ["exec", "turbo", "run", "build", "--force", "--filter=tempo-auth-example-electron..."],
    { cwd: ROOT, stdio: "inherit", timeout: 300_000 },
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
  // Break proof inside the run: a URL off the redirect. The opener must drop it.
  // Its code has the shape of a real one but is not url1's code. The log holds no code, so it
  // cannot show which URL a sign-in used. With url1's code, an opener that took the wrong URL
  // could sign in after url1's open-url line, and the log order would look right. With another
  // code, such an opener writes sign-in-failed (invalid_token), which no timing can hide.
  const wrong = `example-app://other?code=hc_${randomBytes(32).toString("base64url")}`;
  openUrl(wrong);
  await waitFor("open-url of the wrong URL", (e) =>
    e.find((x) => x.event === "open-url" && delivered(x, wrong)),
  );
  openUrl(url1);
  await waitFor("open-url of round 1", (e) =>
    e.find((x) => x.event === "open-url" && delivered(x, url1)),
  );
  // The first round 1 outcome, a sign-in or a failure. The log is one append-only file from one
  // process, so the line index is the exact order of the events.
  const isOutcome1 = (x) =>
    (x.event === "signed-in" || x.event === "sign-in-failed") && x.round === 1;
  await waitFor("round 1 outcome", (e) => e.find(isOutcome1));
  const log1 = events();
  const iWrong = log1.findIndex((x) => x.event === "open-url" && delivered(x, wrong));
  const iRight = log1.findIndex((x) => x.event === "open-url" && delivered(x, url1));
  const iOutcome = log1.findIndex(isOutcome1);
  const outcome1 = log1[iOutcome];
  check("the wrong URL arrived before the right URL", iWrong < iRight);
  check("no round 1 outcome came before the right URL arrived", iOutcome > iRight);
  check(
    `round 1 signed in, not ${outcome1.event} (${outcome1.code ?? "ok"})`,
    outcome1.event === "signed-in",
  );
  check("open-url reached the first instance", log1[iRight].pid === firstPid);
  if (outcome1.event !== "signed-in") throw new Error("round 1 did not sign in; stop the run");
  const s1 = outcome1;

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
  // Each step in its own try: a Worker stop error must not skip the bundle and Keychain cleanup.
  await cleanupStep("stop the first app", () => stopApp(first));
  await cleanupStep("stop the second app", () => stopApp(second));
  await cleanupStep("stop the Worker", () => worker?.stop());
  cleanupSync();
  // A note, not a failure: the preference stays after the bundle is gone (see the header).
  try {
    const roles = handlerPreference("example-app");
    notes.push(
      roles
        ? `LaunchServices keeps a handler preference for example-app after the cleanup: ${roles}`
        : "LaunchServices keeps no handler preference for example-app after the cleanup",
    );
  } catch (e) {
    notes.push(`the handler preference check failed: ${String(e)}`);
  }
}
const record = {
  proof: "electron-open-url-second-instance",
  result: failures.length === 0 ? "pass" : "fail",
  date: new Date().toISOString(),
  macOS,
  electron,
  failures,
  notes,
  events: eventsFile,
};
const line = JSON.stringify(record);
if (record.result === "pass") {
  const resultsDir = join(PKG_DIR, "proof", "results");
  mkdirSync(resultsDir, { recursive: true });
  // "wx" refuses an existing file, so a record is never overwritten.
  writeFileSync(
    join(resultsDir, `electron-macos-${record.date.replace(/[:.]/g, "-")}.json`),
    `${line}\n`,
    { flag: "wx" },
  );
}
console.log(line);
process.exit(failures.length === 0 ? 0 : 1);
