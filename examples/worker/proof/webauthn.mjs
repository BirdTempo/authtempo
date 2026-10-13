// STATUS 2026-10-10: this script was written and linted in a sandboxed session. It was NOT run
// there. The sandbox refuses the Firefox profile folder ("Could not find profile folder", exit 1).
// The owner runs the proof and the break proofs in their own shell. The script builds the client
// itself (turbo with --force) before it reads packages/client/dist, so do not build by hand.
// Firefox:
//   pnpm --filter authtempo-example-worker proof:webauthn firefox
//   PROOF_STUB_TYPEERROR=1 pnpm --filter authtempo-example-worker proof:webauthn firefox
//   PROOF_FORCE_WEAK=1 PROOF_STUB_TYPEERROR=1 pnpm --filter authtempo-example-worker proof:webauthn firefox
// Safari (enable the driver once; it asks for the admin password):
//   sudo safaridriver --enable
//   pnpm --filter authtempo-example-worker proof:webauthn safari
//   PROOF_STUB_TYPEERROR=1 pnpm --filter authtempo-example-worker proof:webauthn safari
//   PROOF_FORCE_WEAK=1 PROOF_STUB_TYPEERROR=1 pnpm --filter authtempo-example-worker proof:webauthn safari
// For each browser, the first run is the proof. The second must fail on the strong path. The
// third must fail on the weak path. PROOF_FORCE_WEAK=1 skips the virtual authenticator.
// FIREFOX_BINARY sets the Firefox binary.
// Each run writes its record to proof/results/webauthn-<browser>[-weak][-stub].json (latest) and
// to the same name with the date added (kept). The record has the path taken, the versions, the
// date, and pass or the exact failure. Keep these files as the evidence.
//
// Xray risk, and how this script avoids it: an execute script in Firefox runs in the
// Marionette sandbox over the window. Writes to PublicKeyCredential from there may land on an
// Xray wrapper and not reach the page, and a page expando on window may not be visible from
// there. So the script injects a <script> element. The whole ceremony (the patches, the client
// calls, the counters) runs in the page world. It stores its report as JSON text in a DOM node,
// <script type="application/json" id="authtempo-proof"> appended to the body. The WebDriver
// script reads that node through the DOM (getElementById, then textContent), which an Xray
// wrapper shows as is. This is the path used; no window expando carries the report. The page
// must have no content security policy. The Worker's own 404 page has none, and the script
// checks the headers first and stops if one appears. If you see "parsers not exercised" on
// Firefox, read it with this design in mind: the injection is the part that no run has tested.
//
// The plan 6c WebAuthn proof for Firefox and Safari. WebDriver over plain fetch, no Selenium.
// It runs the client's built webauthn.js in a page on the Worker origin and runs the passkey
// ceremonies through browserWebAuthn, once with the browser's JSON parsers and once with the
// client's own conversions. Each step counts which conversion code ran. A pass needs that count,
// because a step that never reached the parsers proves nothing about them.
// This proof covers the client package. The sign-in page script of core does not use the client.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, bearerFor, startWorker } from "./dev.mjs";

// Firefox binary: FIREFOX_BINARY, else the standard app path when the file exists, else none.
// The binary was set after a Homebrew wrapper at /opt/homebrew/bin/firefox was suspected. Setting
// it did not change the sandbox failure of 2026-10-10 ("Could not find profile folder").
const firefoxBinary =
  process.env.FIREFOX_BINARY ??
  ["/Applications/Firefox.app/Contents/MacOS/firefox"].find((p) => existsSync(p));

// On macOS 27.0 with Firefox 157.0.1 (checked 2026-10-10, in a normal Terminal), a direct start
// of the Firefox binary ends with status 1 and "Could not find profile folder", while a start
// through LaunchServices (`open`) works. So on macOS the script starts Firefox itself through
// `open` with a Marionette port in its profile, and geckodriver attaches with --connect-existing.
// FIREFOX_LAUNCH=direct keeps the plain geckodriver launch.
const FIREFOX_APP = "/Applications/Firefox.app";
const MARIONETTE_PORT = 2828;
const firefoxThroughOpen =
  process.platform === "darwin" &&
  process.env.FIREFOX_LAUNCH !== "direct" &&
  existsSync(FIREFOX_APP);

const portOpen = (port) =>
  new Promise((done) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      done(true);
    });
    s.once("error", () => done(false));
  });

// Starts Firefox through `open` with a profile that holds the Marionette port. Answers a stop().
async function openFirefox(result) {
  const profile = mkdtempSync(join(tmpdir(), "authtempo-proof-firefox-"));
  writeFileSync(
    join(profile, "user.js"),
    [
      `user_pref("marionette.port", ${MARIONETTE_PORT});`,
      'user_pref("marionette.enabled", true);',
      'user_pref("remote.active-protocols", 3);',
    ].join("\n"),
  );
  if (await portOpen(MARIONETTE_PORT)) {
    throw new Error(`port ${MARIONETTE_PORT} answers already; stop the other Firefox first`);
  }
  const args = ["-marionette", "-headless", "-no-remote", "-profile", profile];
  const opener = spawn("/usr/bin/open", ["-n", "-a", FIREFOX_APP, "--args", ...args], {
    stdio: "ignore",
    timeout: 30_000,
  });
  opener.on("error", (e) => {
    result.firefoxOpenError = String(e);
  });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    up = await portOpen(MARIONETTE_PORT);
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`Firefox did not open Marionette on ${MARIONETTE_PORT} in 30 s`);
  result.firefoxLaunch = "open + geckodriver --connect-existing";
  return () => {
    try {
      // The pattern starts with a dash, so "--" ends the option list.
      execFileSync("pkill", ["-f", "--", `-profile ${profile}`], { timeout: 5_000 });
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  };
}

const BROWSERS = {
  firefox: {
    command: "geckodriver",
    args: firefoxThroughOpen
      ? ["--port", "4445", "--connect-existing", "--marionette-port", String(MARIONETTE_PORT)]
      : ["--port", "4445"],
    port: 4445,
    ...(firefoxThroughOpen ? { prepare: openFirefox } : {}),
    capabilities: firefoxThroughOpen
      ? { browserName: "firefox" }
      : {
          browserName: "firefox",
          "moz:firefoxOptions": {
            ...(firefoxBinary ? { binary: firefoxBinary } : {}),
            args: ["-headless"],
          },
        },
    driverVersion: () =>
      execFileSync("geckodriver", ["--version"], { encoding: "utf8", timeout: 15_000 }).split(
        "\n",
      )[0],
  },
  safari: {
    command: "safaridriver",
    args: ["--port", "4444"],
    port: 4444,
    capabilities: { browserName: "safari" },
    // The plan's constraints ask for the driver version on every record.
    driverVersion: () =>
      execFileSync("safaridriver", ["--version"], { encoding: "utf8", timeout: 15_000 }).trim(),
  },
};
const name = process.argv[2];
const browser = BROWSERS[name];
if (!browser) throw new Error("usage: node proof/webauthn.mjs firefox|safari");
const DRIVER = `http://127.0.0.1:${browser.port}`;
const EMAIL = `webauthn-${name}@example.com`;
// Break proof only: PROOF_STUB_TYPEERROR=1 makes navigator.credentials.create throw a TypeError.
// The script must then fail on both paths.
const STUB = process.env.PROOF_STUB_TYPEERROR === "1";
// Break proof only: PROOF_FORCE_WEAK=1 skips the virtual authenticator, so the weak path runs.
const FORCE_WEAK = process.env.PROOF_FORCE_WEAK === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WEBAUTHN_JS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@authtempo",
  "client",
  "dist",
  "webauthn.js",
);
// The client's built webauthn.js without its export keywords. loadClientSource fills it inside
// the main try, so a failed build or a changed shape ends in a written record, not a crash.
let source = "";
function loadClientSource() {
  // A check that reads build output proves nothing until the build is newer than the change. So
  // build the client from the root with --force (never a cache replay). The build takes seconds;
  // 5 min allows a loaded machine.
  execFileSync("pnpm", ["-w", "turbo", "run", "build", "--filter=@authtempo/client", "--force"], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 300_000,
  });
  const text = readFileSync(WEBAUTHN_JS, "utf8").replace(/^export /gm, "");
  if (
    /^\s*(import|export)\b/m.test(text) ||
    !text.includes("function browserWebAuthn(") ||
    !text.includes("function toBinaryCreationOptions(") ||
    !text.includes("function toBinaryRequestOptions(") ||
    !text.includes("function credentialToJSON(")
  ) {
    throw new Error(`${WEBAUTHN_JS} changed shape: it must be plain functions with no import`);
  }
  source = text;
}

// Runs in the page. It gets browserWebAuthn from the injected source, then the WebDriver arguments.
// The injected source declares toBinaryCreationOptions, toBinaryRequestOptions and credentialToJSON
// as function declarations in this same scope. Assigning to them wraps them with a counter, and
// browserWebAuthn calls the wrapped ones.
function pageCeremony(browserWebAuthn, base, bearer, op, mode, stub, abortMs, done) {
  const PKC = globalThis.PublicKeyCredential;
  const report = {
    op,
    mode,
    native: {
      parseCreationOptionsFromJSON: typeof PKC?.parseCreationOptionsFromJSON === "function",
      parseRequestOptionsFromJSON: typeof PKC?.parseRequestOptionsFromJSON === "function",
      toJSON: typeof PKC?.prototype?.toJSON === "function",
    },
    // Calls of the browser's functions, and of the client's own conversions.
    ran: { nativeParse: 0, nativeToJSON: 0, ownOptions: 0, ownToJSON: 0 },
  };
  // A native step needs the browser's parser for its operation and toJSON. Without them the step
  // has nothing to test, and the fallback steps carry the proof.
  const nativeMissing =
    !(op === "create"
      ? report.native.parseCreationOptionsFromJSON
      : report.native.parseRequestOptionsFromJSON) || !report.native.toJSON;
  if (mode === "native" && nativeMissing) {
    done({ ...report, skipped: "native parsers absent" });
    return;
  }
  const count = (key, fn) =>
    function (...args) {
      report.ran[key]++;
      return fn.apply(this, args);
    };
  if (mode === "fallback" && PKC) {
    // Hide the browser's functions, so browserWebAuthn takes the client's own conversions.
    Object.defineProperty(PKC, "parseCreationOptionsFromJSON", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(PKC, "parseRequestOptionsFromJSON", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(PKC.prototype, "toJSON", { value: undefined, configurable: true });
  } else if (mode === "native" && PKC) {
    for (const [obj, prop, key] of [
      [PKC, "parseCreationOptionsFromJSON", "nativeParse"],
      [PKC, "parseRequestOptionsFromJSON", "nativeParse"],
      [PKC.prototype, "toJSON", "nativeToJSON"],
    ]) {
      if (typeof obj[prop] === "function")
        Object.defineProperty(obj, prop, {
          value: count(key, obj[prop]),
          configurable: true,
          writable: true,
        });
    }
  }
  // These assignments change the function declarations of the injected source.
  toBinaryCreationOptions = count("ownOptions", toBinaryCreationOptions);
  toBinaryRequestOptions = count("ownOptions", toBinaryRequestOptions);
  credentialToJSON = count("ownToJSON", credentialToJSON);
  // An abort after abortMs (8 s, or 120 s in manual mode) ends a ceremony that no authenticator
  // answers, so the script never hangs.
  const container = {
    create: (o) => {
      if (stub) throw new TypeError("stub: navigator.credentials.create");
      return globalThis.navigator.credentials.create({
        ...o,
        signal: AbortSignal.timeout(abortMs),
      });
    },
    get: (o) =>
      globalThis.navigator.credentials.get({ ...o, signal: AbortSignal.timeout(abortMs) }),
  };
  const webauthn = browserWebAuthn(container);
  const post = async (path, body, withBearer) => {
    const headers = { "content-type": "application/json" };
    if (withBearer) headers.authorization = `Bearer ${bearer}`;
    const r = await fetch(`${base}/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const run = async () => {
    if (op === "create") {
      const options = await post("/passkey/register/options", {}, true);
      report.optionsStatus = options.status;
      if (options.status !== 200) return { ...report, options };
      const response = await webauthn.create(options.body);
      return {
        ...report,
        verify: await post("/passkey/register/verify", { response, name: `proof-${mode}` }, true),
      };
    }
    const options = await post("/passkey/authenticate/options", {}, false);
    report.optionsStatus = options.status;
    if (options.status !== 200) return { ...report, options };
    const response = await webauthn.get(options.body);
    return { ...report, verify: await post("/passkey/authenticate/verify", { response }, false) };
  };
  run().then(done, (e) =>
    done({ ...report, error: { name: e?.name ?? "unknown", message: String(e?.message ?? e) } }),
  );
}
// The page-world text. The source declares its functions inside the arrow function, so the
// assignments in pageCeremony reach them. The report, or a throw, goes to the DOM node that the
// poll reads (see the Xray note in the header).
const REPORT_ID = "authtempo-proof";
const pageText = (op, mode, bearer, abortMs) =>
  `(() => { const save = (r) => { const el = document.createElement("script"); el.type = "application/json"; el.id = ${JSON.stringify(REPORT_ID)}; el.textContent = JSON.stringify(r); (document.body ?? document.documentElement).appendChild(el); }; try { ${source}\n(${pageCeremony.toString()})(browserWebAuthn, ${JSON.stringify(BASE)}, ${JSON.stringify(bearer)}, ${JSON.stringify(op)}, ${JSON.stringify(mode)}, ${JSON.stringify(STUB)}, ${JSON.stringify(abortMs)}, save); } catch (e) { save({ pageError: String(e) }); } })();`;
// Reads the report through the DOM, never through a window property.
const POLL = `const el = document.getElementById(${JSON.stringify(REPORT_ID)}); return el ? el.textContent : null;`;
const INJECT = `const el = document.createElement("script"); el.textContent = arguments[0]; document.documentElement.appendChild(el); return null;`;

// Every driver call has a timeout: 60 s for a new session, 40 s for the rest.
async function wd(method, path, body) {
  const r = await fetch(`${DRIVER}${path}`, {
    signal: AbortSignal.timeout(method === "POST" && path === "/session" ? 60_000 : 40_000),
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, value: (await r.json()).value };
}

// The evidence that a step reached the conversion code it claims to test.
// native: the browser's functions ran and the client's own did not.
// fallback: the client's own ran and the browser's did not.
// On the weak path no credential comes back, so only the options conversion is checked.
function exercised(s, hasCredential) {
  const { ran, native } = s;
  if (s.mode === "native") {
    const parsersExist =
      s.op === "create" ? native.parseCreationOptionsFromJSON : native.parseRequestOptionsFromJSON;
    return (
      parsersExist &&
      ran.nativeParse > 0 &&
      ran.ownOptions === 0 &&
      (!hasCredential || (native.toJSON && ran.nativeToJSON > 0 && ran.ownToJSON === 0))
    );
  }
  return (
    ran.ownOptions > 0 &&
    ran.nativeParse === 0 &&
    (!hasCredential || (ran.ownToJSON > 0 && ran.nativeToJSON === 0))
  );
}

// The weak path accepts only a cancel, the abort of the script itself, or a ConstraintError. Any
// other name fails. A ConstraintError is the WebAuthn outcome when the authenticator cannot give
// the required resident key or user verification (Web Authentication Level 3, create() step on
// authenticatorSelection); the browser raises it after it parsed the options, so it is evidence
// that the option shapes were accepted. Firefox 157.0.1's virtual authenticator answers it for
// every ceremony that requires both (checked 2026-10-10; geckodriver 0.37.1 calls these endpoints
// unreliable).
const WEAK_OK = new Set([
  "WebAuthnCancelled",
  "NotAllowedError",
  "TimeoutError",
  "AbortError",
  "ConstraintError",
]);
const weakStepOk = (s) => s.optionsStatus === 200 && s.error && WEAK_OK.has(s.error.name);

const result = {
  proof: `webauthn-${name}`,
  result: "fail",
  date: new Date().toISOString(),
  macOS: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  ...(STUB ? { stub: "navigator.credentials.create throws TypeError" } : {}),
  ...(FORCE_WEAK ? { forceWeak: true } : {}),
};
let driver = null;
let driverSpawnError = null;
let worker = null;
let session = null;
let stopBrowser = null;
const killDriver = () => {
  driver?.kill();
  stopBrowser?.();
};
process.on("exit", killDriver);
const probe = (url) => fetch(url, { signal: AbortSignal.timeout(2_000) });
try {
  loadClientSource();
  const busy = await probe(`${DRIVER}/status`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`port ${browser.port} answers already; stop the other driver first`);
  result.driver = browser.driverVersion();
  if (browser.prepare) stopBrowser = await browser.prepare(result);
  driver = spawn(browser.command, browser.args, { stdio: "ignore" });
  driver.on("error", (e) => {
    driverSpawnError = String(e);
    result.driverSpawnError = driverSpawnError;
  });
  let ready = false;
  for (let i = 0; i < 50 && !ready && !driverSpawnError; i++) {
    try {
      ready = (await probe(`${DRIVER}/status`)).ok;
    } catch {}
    if (!ready) await sleep(200);
  }
  if (!ready) {
    throw new Error(
      `${browser.command} did not answer in 10 s${driverSpawnError ? `: ${driverSpawnError}` : ""}`,
    );
  }
  worker = await startWorker();
  const bearer = await bearerFor(EMAIL);

  // The ceremony runs in a script element, so the Worker page must carry no content security policy.
  const pageHeaders = (await fetch(`${BASE}/__proof`, { signal: AbortSignal.timeout(10_000) }))
    .headers;
  if (pageHeaders.get("content-security-policy")) {
    throw new Error(
      "the page has a content security policy; add a TEST_MODE route /__test/webauthn that serves a harness page",
    );
  }

  // Ask for virtual authenticators first; a driver that refuses the capability gets a plain session.
  let created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: { ...browser.capabilities, "webauthn:virtualAuthenticators": true },
    },
  });
  result.virtualCapability =
    created.status === 200 ? "accepted" : (created.value?.message ?? `HTTP ${created.status}`);
  if (created.status !== 200) {
    created = await wd("POST", "/session", { capabilities: { alwaysMatch: browser.capabilities } });
  }
  if (created.status !== 200) throw new Error(`no session: ${JSON.stringify(created.value)}`);
  session = created.value.sessionId;
  result.browserVersion = created.value.capabilities.browserVersion;
  await wd("POST", `/session/${session}/timeouts`, { script: 30_000, pageLoad: 30_000 });

  // PROOF_AUTHENTICATOR holds a JSON object merged over this default, for driver experiments.
  const authenticator = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserConsenting: true,
    isUserVerified: true,
    ...(process.env.PROOF_AUTHENTICATOR ? JSON.parse(process.env.PROOF_AUTHENTICATOR) : {}),
  };
  result.authenticator = authenticator;
  const addAuthenticator = async () => {
    const r = await wd("POST", `/session/${session}/webauthn/authenticator`, authenticator);
    return r.status === 200 ? { id: r.value } : { error: r.value?.message ?? `HTTP ${r.status}` };
  };
  // PROOF_MANUAL=1: no virtual authenticator; the owner approves the browser's own passkey prompts
  // on screen (Touch ID on this Mac), and the script checks the server side. Safari 27.0 shows its
  // platform sheet even with a virtual authenticator added (checked 2026-10-10), so this is the
  // strong-path proof on Safari. The second registration uses a second account, because a real
  // authenticator refuses a duplicate credential through excludeCredentials.
  const MANUAL = process.env.PROOF_MANUAL === "1";
  const EMAIL2 = `webauthn-${name}-2@example.com`;
  const bearer2 = MANUAL ? await bearerFor(EMAIL2) : null;
  const POLLS = MANUAL ? 600 : 150;
  if (MANUAL) {
    await wd("POST", `/session/${session}/timeouts`, { script: 120_000, pageLoad: 30_000 });
  }
  const ceremony = async (op, mode) => {
    const fail = (driverError) => ({ op, mode, driverError });
    // A 404 text page on the Worker origin: same origin as the passkey routes.
    const nav = await wd("POST", `/session/${session}/url`, { url: `${BASE}/__proof` });
    if (nav.status !== 200) return fail(nav.value);
    const token = MANUAL && op === "create" && mode === "fallback" ? bearer2 : bearer;
    if (MANUAL) {
      process.stderr.write(`\n>>> approve the passkey prompt in ${name} now (${op}, ${mode})\n`);
    }
    const inject = await wd("POST", `/session/${session}/execute/sync`, {
      script: INJECT,
      args: [pageText(op, mode, token, MANUAL ? 120_000 : 8_000)],
    });
    if (inject.status !== 200) return fail(inject.value);
    for (let i = 0; i < POLLS; i++) {
      const r = await wd("POST", `/session/${session}/execute/sync`, { script: POLL, args: [] });
      if (r.status !== 200) return fail(r.value);
      if (typeof r.value === "string") {
        let report;
        try {
          report = JSON.parse(r.value);
        } catch {
          return fail(`the report node holds no JSON: ${r.value.slice(0, 200)}`);
        }
        return report?.ran ? report : fail(report);
      }
      await sleep(200);
    }
    return fail(`no report in ${MANUAL ? "120" : "30"} s`);
  };

  const first = MANUAL
    ? { id: "manual" }
    : FORCE_WEAK
      ? { error: "PROOF_FORCE_WEAK=1" }
      : await addAuthenticator();
  result.virtualAuthenticator = MANUAL
    ? "none: the owner approved the browser's own prompts (PROOF_MANUAL=1)"
    : first.id
      ? "added"
      : first.error;
  const steps = [];
  const ran = (s) => !s.skipped;
  if (first.id) {
    result.path = "strong";
    steps.push(await ceremony("create", "native"));
    if (!MANUAL) {
      // A second credential on the same authenticator fails on excludeCredentials. A fresh one
      // also sends the first credential id through the fallback conversion of excludeCredentials.
      await wd("DELETE", `/session/${session}/webauthn/authenticator/${first.id}`);
      const second = await addAuthenticator();
      if (!second.id) throw new Error(`second authenticator: ${second.error}`);
    }
    steps.push(await ceremony("create", "fallback"));
    steps.push(await ceremony("get", "fallback"));
    steps.push(await ceremony("get", "native"));
    const active = steps.filter(ran);
    const owners = MANUAL ? [EMAIL, EMAIL2] : [EMAIL];
    const ceremoniesOk = active.every(
      (s) =>
        !s.driverError &&
        !s.error &&
        s.verify?.status === 200 &&
        (s.op === "create" || owners.includes(s.verify.body?.user?.email)),
    );
    const parsersRan = active.every((s) => s.ran && exercised(s, true));
    result.parsersExercised = parsersRan;
    // A pass without the evidence is "parsers not exercised", and that is a failure.
    result.result = ceremoniesOk && parsersRan ? "pass" : "fail";
    if (ceremoniesOk && !parsersRan) result.reason = "parsers not exercised";
    // When the virtual authenticator does not serve the ceremonies, every step ends in an error the
    // weak rule accepts (a ConstraintError for the required resident key or user verification, or a
    // dismissed browser prompt), and the strong path is unusable. The same steps then count under
    // the weak rule: the options were accepted, and the fallback parsers ran.
    // Manual mode never degrades: the owner approved real prompts, so the strong path must hold.
    const constrained =
      !MANUAL &&
      !ceremoniesOk &&
      active.length > 0 &&
      active.every((s) => !s.driverError && s.error && WEAK_OK.has(s.error.name));
    if (constrained) {
      result.path = "weak";
      result.reason = `virtual authenticator did not serve the ceremonies (${[...new Set(active.map((s) => s.error.name))].join(", ")}); weak rule applied`;
      const rejected = active.every((s) => !s.driverError && weakStepOk(s));
      const weakParsersRan = active.every((s) => s.ran && exercised(s, false));
      result.parsersExercised = weakParsersRan;
      result.result = rejected && weakParsersRan ? "pass" : "fail";
    }
  } else {
    result.path = "weak";
    for (const [op, mode] of [
      ["create", "native"],
      ["create", "fallback"],
      ["get", "native"],
      ["get", "fallback"],
    ]) {
      steps.push(await ceremony(op, mode));
    }
    const active = steps.filter(ran);
    const rejected = active.every((s) => !s.driverError && weakStepOk(s));
    const parsersRan = active.every((s) => s.ran && exercised(s, false));
    result.parsersExercised = parsersRan;
    result.result = rejected && parsersRan ? "pass" : "fail";
    if (rejected && !parsersRan) result.reason = "parsers not exercised";
  }
  result.skipped = steps.filter((s) => s.skipped).map((s) => `${s.op}/${s.mode}: ${s.skipped}`);
  result.steps = steps;
} catch (e) {
  result.error = String(e);
} finally {
  // The record must be written whatever the cleanup does.
  try {
    if (session) await wd("DELETE", `/session/${session}`);
  } catch (e) {
    result.sessionStopError = String(e);
  }
  try {
    killDriver();
  } catch (e) {
    result.driverStopError = String(e);
  }
  try {
    await worker?.stop();
  } catch (e) {
    result.stopError = String(e);
  }
}
const line = JSON.stringify(result);
const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(resultsDir, { recursive: true });
// The latest record, and a dated copy that a later run never overwrites.
const base = `webauthn-${name}${process.env.PROOF_MANUAL === "1" ? "-manual" : ""}${FORCE_WEAK ? "-weak" : ""}${STUB ? "-stub" : ""}`;
writeFileSync(join(resultsDir, `${base}.json`), `${line}\n`);
writeFileSync(join(resultsDir, `${base}-${result.date.replace(/[:.]/g, "-")}.json`), `${line}\n`);
console.log(line);
process.exit(result.result === "pass" ? 0 : 1);
