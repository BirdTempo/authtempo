// One body through the full read path of core in a child process with a
// small heap (rulings 46 and 51 of the 12j lane). body-memory.test.ts starts it as
//   node --max-old-space-size=128 --expose-gc body-memory-child.mjs <route> <shape>
// and reads one JSON line. A fatal out-of-memory ends the process with no line.
// It imports the build: the test checks that dist is newer than src first.
// The route picks the reader: the SAML ACS posts its form through createAuth,
// a SCIM route reads with readScimBody, and every other route reads with readJson.
import v8 from "node:v8";

const dist = new URL("../../dist/", import.meta.url);
const { bindBodyRoute, bodyCapOf, BODY_DEPTH_MAX, BODY_ITEMS_MAX, FORM_PAIRS_MAX } = await import(
  new URL("http/body-cap.js", dist).href
);
const { holdsBadText } = await import(new URL("http/body-text.js", dist).href);
const { readJson } = await import(new URL("http/json.js", dist).href);
const { ROUTE_CONTRACT } = await import(new URL("http/contract/index.js", dist).href);
const { SAML_FORM_MAX } = await import(new URL("engine/sso/saml-sp.js", dist).href);
const { readScimBody, SCIM_BODY_MAX } = await import(new URL("http/routes/scim.js", dist).href);
const core = await import(new URL("index.js", dist).href);

const ACS = "POST /sso/:connectionId/acs";
const SCIM = "POST /scim/v2/Users";

const [route, shape] = process.argv.slice(2);
const cap = route === ACS ? SAML_FORM_MAX : route === SCIM ? SCIM_BODY_MAX : bodyCapOf(route);

/** `head`, then `unit` as many times as fits, then `tail`: at most `size` bytes of ASCII. */
function fill(head, unit, tail, size = cap) {
  const n = Math.max(0, Math.floor((size - head.length - tail.length) / unit.length));
  return head + unit.repeat(n) + tail;
}

/** `text` with spaces after it, to exactly `cap` bytes of ASCII. */
const pad = (text) => text + " ".repeat(cap - text.length);

/** A chain of arrays `depth` deep, inside the outer object and array: `[[...]]`. */
const chain = (depth) => `${"[".repeat(depth - 2)}${"]".repeat(depth - 2)}`;

/** `unit` as many times as fits, then the last key of `a` to exactly `cap` bytes: a form. */
const formFill = (unit) => fill("", unit, "", cap - 1).padEnd(cap, "a");

const JSON_SHAPES = {
  // A flat array of zeros to the cap: the walk shape of the review.
  zeros: () => fill('{"x":[', "0,", "0]}"),
  // As many zeros as the item limit allows, then spaces to the cap.
  "zeros-at-limit": () => pad(`{"x":[${"0,".repeat(BODY_ITEMS_MAX - 3)}0]}`),
  // Chains at the depth limit to the cap: the parse shape of the review.
  nesting: () => fill('{"x":[', `${chain(BODY_DEPTH_MAX)},`, `${chain(BODY_DEPTH_MAX)}]}`),
  // As many chains at the depth limit as the item limit allows, then spaces.
  "nesting-at-limit": () => {
    const n = Math.floor((BODY_ITEMS_MAX - 2) / (BODY_DEPTH_MAX - 1));
    return pad(`{"x":[${Array.from({ length: n }, () => chain(BODY_DEPTH_MAX)).join(",")}]}`);
  },
  // One string to the cap.
  string: () => `{"x":"${"a".repeat(cap - 9)}"}`,
  // Short keys to the cap.
  keys: () => {
    const parts = [];
    let length = 2;
    for (let i = 0; length + 12 < cap; i++) {
      const part = `"${i.toString(36)}":0`;
      parts.push(part);
      length += part.length + 1;
    }
    return `{${parts.join(",")}}`;
  },
  // As many keys as the item limit allows, each long, to the cap.
  "keys-at-limit": () => {
    const n = BODY_ITEMS_MAX - 1;
    const width = Math.floor((cap - 2) / n) - 5;
    const keys = Array.from({ length: n }, (_, i) => `"${i.toString(36).padStart(width, "k")}":0`);
    return pad(`{${keys.join(",")}}`);
  },
};

// The ACS form at SAML_FORM_MAX (ruling 51 Major 1): the probes of the re-review.
const FORM_SHAPES = {
  // Keys with no "=": Node's URLSearchParams took 5.2 s at the cap.
  "form-keys": () => formFill("a&"),
  // Empty pairs: 64 to 80 MB of heap at the cap.
  "form-empty": () => formFill("=&"),
  // Escaped keys with no "=".
  "form-escapes": () => formFill("%41&"),
  // Short pairs.
  "form-pairs": () => formFill("a=b&"),
  // One value to the cap, as an IdP posts it.
  "form-value": () => `SAMLResponse=${"a".repeat(cap - 26)}&RelayState=x`,
  // FORM_PAIRS_MAX pairs, each long, to the cap.
  "form-at-limit": () => {
    const width = Math.floor((cap - (FORM_PAIRS_MAX - 1)) / FORM_PAIRS_MAX);
    const pairs = Array.from({ length: FORM_PAIRS_MAX }, (_, i) =>
      `k${i.toString(36).padStart(3, "0")}=`.padEnd(width, "a"),
    );
    return pairs.join("&").padEnd(cap, "a");
  },
};

// The SCIM body at SCIM_BODY_MAX (ruling 51): its own reader has no shape scan.
const SCIM_SHAPES = {
  nesting: () => `${"[".repeat(cap / 2)}${"]".repeat(cap / 2)}`,
  zeros: () => fill("[", "0,", "0]"),
  empties: () => fill("[", "[],", "[]]"),
  objects: () => fill("[", "{},", "{}]"),
  string: JSON_SHAPES.string,
  keys: JSON_SHAPES.keys,
};

const SHAPES = route === ACS ? FORM_SHAPES : route === SCIM ? SCIM_SHAPES : JSON_SHAPES;
const make = SHAPES[shape];
if (make === undefined || (route !== SCIM && ROUTE_CONTRACT[route]?.body === undefined))
  throw new Error(`no shape ${shape} or no body of ${route}`);
const bytes = new TextEncoder().encode(make());

/** The answer of the reader of the route: "ok", the code, or the status. */
async function answerOf() {
  if (process.argv[4] === "walk")
    // The text walk alone on the parsed body, with no scan before it.
    return holdsBadText(JSON.parse(new TextDecoder().decode(bytes))) ? "bad" : "clean";
  if (route === ACS) {
    const auth = core.createAuth({
      baseURL: "https://auth.test",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: core.createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    });
    // No sign-in and no connection: the ACS reads the form before any check.
    const res = await auth.handle(
      new Request("https://auth.test/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://idp.example",
        },
        body: bytes,
      }),
    );
    return `${res.status} ${new URL(res.headers.get("location") ?? "x:").searchParams.get("auth_error")}`;
  }
  const request = new Request("https://auth.test/auth/x", {
    method: "POST",
    headers: { "content-type": route === SCIM ? "application/scim+json" : "application/json" },
    body: bytes,
  });
  if (route === SCIM) {
    const r = await readScimBody(request);
    return r.ok ? "ok" : String(r.response.status);
  }
  bindBodyRoute(request, route);
  try {
    const result = await readJson(request, ROUTE_CONTRACT[route].body.schema);
    return result.ok ? "ok" : result.code;
  } catch (e) {
    return e instanceof Error ? e.name : String(e);
  }
}

globalThis.gc();
const before = process.memoryUsage().rss;
// The heap before each collection of the read, and at its end: the peak is the largest.
const profiler = new v8.GCProfiler();
profiler.start();
// The array buffers (the bytes of the body and its chunks) at each turn of the loop and at the end.
let arrayBuffers = process.memoryUsage().arrayBuffers;
const sampler = setInterval(() => {
  arrayBuffers = Math.max(arrayBuffers, process.memoryUsage().arrayBuffers);
}, 1);
const started = performance.now();
const answer = await answerOf();
const ms = Math.round(performance.now() - started);
clearInterval(sampler);
arrayBuffers = Math.max(arrayBuffers, process.memoryUsage().arrayBuffers);
const stats = profiler.stop().statistics;
const used = [
  v8.getHeapStatistics().used_heap_size,
  ...stats.map((s) => s.beforeGC.heapStatistics.usedHeapSize),
];
console.log(
  JSON.stringify({
    route,
    shape,
    cap,
    bytes: bytes.length,
    answer,
    ms,
    // The most heap in use during the read, in MB: before each collection and at the end.
    peakHeapMB: Math.round(Math.max(...used) / 2 ** 20),
    // The most array buffer memory in the read, in MB, the body itself included.
    peakArrayBuffersMB: Math.round(arrayBuffers / 2 ** 20),
    collections: stats.length,
    // The growth of the resident memory of the process in the read, in MB.
    readRssMB: Math.max(0, Math.round((process.resourceUsage().maxRSS * 1024 - before) / 2 ** 20)),
  }),
);
