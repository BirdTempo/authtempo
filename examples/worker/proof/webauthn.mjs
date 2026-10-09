// STATUS 2026-10-10: this script was written and linted in a sandboxed session. It was NOT run
// there. The sandbox refuses the Firefox profile folder ("Could not find profile folder", exit 1).
// The owner runs the proof and the two break proofs in their own shell:
//   pnpm --filter tempo-auth-example-worker proof:webauthn firefox
//   PROOF_STUB_TYPEERROR=1 pnpm --filter tempo-auth-example-worker proof:webauthn firefox
// Each run writes its result record to proof/results/webauthn-<browser>[-stub].json: the path
// taken, the versions, the date, and pass or the exact failure. Keep those files as the evidence.
// The plan 6c WebAuthn proof for Firefox and Safari. WebDriver over plain fetch, no Selenium.
// It injects the client's built webauthn.js into a page on the Worker origin and runs the passkey
// ceremonies through browserWebAuthn, once with the browser's JSON parsers and once with the
// client's own conversions. Each step counts which conversion code ran. A pass needs that count,
// because a step that never reached the parsers proves nothing about them.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, bearerFor, startWorker } from "./dev.mjs";

const BROWSERS = {
  firefox: {
    command: "geckodriver",
    args: ["--port", "4445"],
    port: 4445,
    // The binary is set by path. geckodriver 0.37.1 otherwise finds a Homebrew wrapper script
    // at /opt/homebrew/bin/firefox, and that wrapper loses the -profile argument (checked 2026-10-10).
    capabilities: {
      browserName: "firefox",
      "moz:firefoxOptions": {
        binary: "/Applications/Firefox.app/Contents/MacOS/firefox",
        args: ["-headless"],
      },
    },
    driverVersion: () =>
      execFileSync("geckodriver", ["--version"], { encoding: "utf8" }).split("\n")[0],
  },
  safari: {
    command: "safaridriver",
    args: ["--port", "4444"],
    port: 4444,
    capabilities: { browserName: "safari" },
    driverVersion: () => "safaridriver of the installed Safari",
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEBAUTHN_JS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@tempo-auth",
  "client",
  "dist",
  "webauthn.js",
);
const source = readFileSync(WEBAUTHN_JS, "utf8").replace(/^export /gm, "");
if (
  /^\s*(import|export)\b/m.test(source) ||
  !source.includes("function browserWebAuthn(") ||
  !source.includes("function toBinaryCreationOptions(") ||
  !source.includes("function toBinaryRequestOptions(") ||
  !source.includes("function credentialToJSON(")
) {
  throw new Error(`${WEBAUTHN_JS} changed shape: it must be plain functions with no import`);
}

// Runs in the page. It gets browserWebAuthn from the injected source, then the WebDriver arguments.
// The injected source declares toBinaryCreationOptions, toBinaryRequestOptions and credentialToJSON
// as function declarations in this same scope. Assigning to them wraps them with a counter, and
// browserWebAuthn calls the wrapped ones.
function pageCeremony(browserWebAuthn, base, bearer, op, mode, stub, done) {
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
  // An abort after 8 s ends a ceremony that no authenticator answers, so the script never hangs.
  const container = {
    create: (o) => {
      if (stub) throw new TypeError("stub: navigator.credentials.create");
      return globalThis.navigator.credentials.create({ ...o, signal: AbortSignal.timeout(8000) });
    },
    get: (o) => globalThis.navigator.credentials.get({ ...o, signal: AbortSignal.timeout(8000) }),
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
      if (options.status !== 200) return { ...report, options };
      const response = await webauthn.create(options.body);
      return {
        ...report,
        verify: await post("/passkey/register/verify", { response, name: `proof-${mode}` }, true),
      };
    }
    const options = await post("/passkey/authenticate/options", {}, false);
    if (options.status !== 200) return { ...report, options };
    const response = await webauthn.get(options.body);
    return { ...report, verify: await post("/passkey/authenticate/verify", { response }, false) };
  };
  run().then(done, (e) =>
    done({ ...report, error: { name: e?.name ?? "unknown", message: String(e?.message ?? e) } }),
  );
}
const SCRIPT = `${source}\nreturn (${pageCeremony.toString()})(browserWebAuthn, ...arguments);`;

async function wd(method, path, body) {
  const r = await fetch(`${DRIVER}${path}`, {
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

const result = {
  proof: `webauthn-${name}`,
  result: "fail",
  date: new Date().toISOString(),
  macOS: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  ...(STUB ? { stub: "navigator.credentials.create throws TypeError" } : {}),
};
let driver = null;
let worker = null;
let session = null;
try {
  try {
    await fetch(`${DRIVER}/status`);
    throw new Error(`port ${browser.port} answers already; stop the other driver first`);
  } catch (e) {
    if (String(e).includes("answers already")) throw e;
  }
  result.driver = browser.driverVersion();
  driver = spawn(browser.command, browser.args, { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${DRIVER}/status`)).ok) break;
    } catch {}
    await sleep(200);
  }
  worker = await startWorker();
  const bearer = await bearerFor(EMAIL);

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

  const authenticator = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserConsenting: true,
    isUserVerified: true,
  };
  const addAuthenticator = async () => {
    const r = await wd("POST", `/session/${session}/webauthn/authenticator`, authenticator);
    return r.status === 200 ? { id: r.value } : { error: r.value?.message ?? `HTTP ${r.status}` };
  };
  const ceremony = async (op, mode) => {
    // A 404 text page on the Worker origin: same origin as the passkey routes, no content security policy.
    await wd("POST", `/session/${session}/url`, { url: `${BASE}/__proof` });
    const r = await wd("POST", `/session/${session}/execute/async`, {
      script: SCRIPT,
      args: [BASE, bearer, op, mode, STUB],
    });
    return r.value;
  };

  const first = await addAuthenticator();
  result.virtualAuthenticator = first.id ? "added" : first.error;
  const steps = [];
  if (first.id) {
    result.path = "strong";
    steps.push(await ceremony("create", "native"));
    // A second credential on the same authenticator fails on excludeCredentials. A fresh one also
    // sends the first credential id through the fallback conversion of excludeCredentials.
    await wd("DELETE", `/session/${session}/webauthn/authenticator/${first.id}`);
    const second = await addAuthenticator();
    if (!second.id) throw new Error(`second authenticator: ${second.error}`);
    steps.push(await ceremony("create", "fallback"));
    steps.push(await ceremony("get", "fallback"));
    steps.push(await ceremony("get", "native"));
    const ceremoniesOk = steps.every(
      (s) =>
        !s.error &&
        s.verify?.status === 200 &&
        (s.op === "create" || s.verify.body?.user?.email === EMAIL),
    );
    const parsersRan = steps.every((s) => s.ran && exercised(s, true));
    result.parsersExercised = parsersRan;
    // A pass without the evidence is "parsers not exercised", and that is a failure.
    result.result = ceremoniesOk && parsersRan ? "pass" : "fail";
    if (ceremoniesOk && !parsersRan) result.reason = "parsers not exercised";
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
    const rejected = steps.every((s) => s.error && s.error.name !== "TypeError");
    const parsersRan = steps.every((s) => s.ran && exercised(s, false));
    result.parsersExercised = parsersRan;
    result.result = rejected && parsersRan ? "pass" : "fail";
    if (rejected && !parsersRan) result.reason = "parsers not exercised";
  }
  result.steps = steps;
} catch (e) {
  result.error = String(e);
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver?.kill();
  await worker?.stop();
}
const line = JSON.stringify(result);
const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, `webauthn-${name}${STUB ? "-stub" : ""}.json`), `${line}\n`);
console.log(line);
process.exit(result.result === "pass" ? 0 : 1);
