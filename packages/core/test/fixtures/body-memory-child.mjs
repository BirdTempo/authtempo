// One body through the full read path of core in a child process with a
// small heap (ruling 46 of the 12j lane). body-memory.test.ts starts it as
//   node --max-old-space-size=128 --expose-gc body-memory-child.mjs <route> <shape>
// and reads one JSON line. A fatal out-of-memory ends the process with no line.
// It imports the build: the test checks that dist is newer than src first.
import v8 from "node:v8";

const dist = new URL("../../dist/", import.meta.url);
const { bindBodyRoute, bodyCapOf, BODY_DEPTH_MAX, BODY_ITEMS_MAX } = await import(
  new URL("http/body-cap.js", dist).href
);
const { holdsBadText } = await import(new URL("http/body-text.js", dist).href);
const { readJson } = await import(new URL("http/json.js", dist).href);
const { ROUTE_CONTRACT } = await import(new URL("http/contract/index.js", dist).href);

const [route, shape] = process.argv.slice(2);
const cap = bodyCapOf(route);

/** `head`, then `unit` as many times as fits, then `tail`: at most `size` bytes of ASCII. */
function fill(head, unit, tail, size = cap) {
  const n = Math.max(0, Math.floor((size - head.length - tail.length) / unit.length));
  return head + unit.repeat(n) + tail;
}

/** `text` with spaces after it, to exactly `cap` bytes of ASCII. */
const pad = (text) => text + " ".repeat(cap - text.length);

/** A chain of arrays `depth` deep, inside the outer object and array: `[[...]]`. */
const chain = (depth) => `${"[".repeat(depth - 2)}${"]".repeat(depth - 2)}`;

const SHAPES = {
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

const make = SHAPES[shape];
if (make === undefined || ROUTE_CONTRACT[route]?.body === undefined)
  throw new Error(`no shape ${shape} or no body of ${route}`);
const bytes = new TextEncoder().encode(make());
globalThis.gc();
const before = process.memoryUsage().rss;
// The heap before each collection of the read, and at its end: the peak is the largest.
const profiler = new v8.GCProfiler();
profiler.start();
let answer;
if (process.argv[4] === "walk") {
  // The text walk alone on the parsed body, with no scan before it.
  answer = holdsBadText(JSON.parse(new TextDecoder().decode(bytes))) ? "bad" : "clean";
} else {
  const request = new Request("https://auth.test/auth/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bytes,
  });
  bindBodyRoute(request, route);
  try {
    const result = await readJson(request, ROUTE_CONTRACT[route].body.schema);
    answer = result.ok ? "ok" : result.code;
  } catch (e) {
    answer = e instanceof Error ? e.name : String(e);
  }
}
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
    // The most heap in use during the read, in MB: before each collection and at the end.
    peakHeapMB: Math.round(Math.max(...used) / 2 ** 20),
    collections: stats.length,
    // The growth of the resident memory of the process in the read, in MB.
    readRssMB: Math.max(0, Math.round((process.resourceUsage().maxRSS * 1024 - before) / 2 ** 20)),
  }),
);
