import { sentences } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The page, by its path under src/content/docs/. */
export const PERFORMANCE_PAGE = "docs/operations/performance.md";
/** The record of the run, by its path under apps/site/. measure-performance.ts writes it. */
export const PERFORMANCE_DATA = "src/data/performance.json";

/** The block that measure-performance.ts writes. No person types a number between them. */
export const MEASURED_START = "<!-- measured:start -->";
export const MEASURED_END = "<!-- measured:end -->";

/**
 * The five operations of plan 12h Task 15, in the order of the run. The
 * session, the token, and the key set read the sessions that the sign-ins open.
 */
export const MEASURED_ROUTES = [
  "POST /password/sign-in",
  "GET /session",
  "GET /token",
  "GET /jwks",
  "POST /magic-link/request",
] as const;

/** An operation with fewer samples than this has no p95 worth a row. */
export const MIN_SAMPLES = 100;

/** The first sentence under the table starts with this text (plan 12h Task 15 rule 4). */
export const NOT_DEPLOYED = "Local workerd is not a deployed Worker";

/** The p50, the p95, and the maximum of one set of times, in milliseconds. */
export interface Spread {
  p50: number;
  p95: number;
  max: number;
}

/** The record of one run of measure-performance.ts (plan 12h Task 15). */
export interface PerformanceData {
  measuredAt: string;
  commit: string;
  machine: { os: string; release: string; cpu: string; cores: number; memoryGiB: number };
  load: { before: [number, number, number]; after: [number, number, number] };
  runtime: { wrangler: string; workerd: "local"; node: string };
  storage: "d1-local";
  pbkdf2Iterations: number;
  warmup: number;
  operations: Array<{ route: string; samples: number; serverMs: Spread; clientMs: Spread }>;
}

/** A load triple as the page shows it: the 1, 5, and 15 minute averages. */
function loadText(load: readonly number[]): string {
  return `${load.map((n) => n.toFixed(2)).join(", ")} (1, 5, and 15 minutes)`;
}

/** A time as the page shows it, with one decimal. */
function ms(n: number): string {
  return n.toFixed(1);
}

/**
 * The block between the markers: the conditions, then the table. Both come
 * from the record, so a hand edit of either fails check-performance.
 */
export function renderPerformanceTable(data: PerformanceData): string {
  const m = data.machine;
  const conditions = [
    "| Condition | Value |",
    "| --- | --- |",
    `| Date (UTC) | ${data.measuredAt} |`,
    `| Commit | \`${data.commit}\` |`,
    `| Machine | ${m.os} ${m.release}, ${m.cpu}, ${m.cores} cores, ${m.memoryGiB} GiB of memory |`,
    `| Load before the run | ${loadText(data.load.before)} |`,
    `| Load after the run | ${loadText(data.load.after)} |`,
    `| Runtime | wrangler ${data.runtime.wrangler}, ${data.runtime.workerd} workerd, Node ${data.runtime.node} |`,
    `| Storage | ${data.storage === "d1-local" ? "local D1 through Miniflare" : data.storage} |`,
    `| PBKDF2 iterations | ${data.pbkdf2Iterations} |`,
    `| Calls to warm up | ${data.warmup} for each operation, not in the table |`,
  ];
  const table = [
    "| Operation | Samples | Server p50 | Server p95 | Server max | Client p50 | Client p95 | Client max |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...data.operations
      .map((o) =>
        [
          `\`${o.route}\``,
          String(o.samples),
          ms(o.serverMs.p50),
          ms(o.serverMs.p95),
          ms(o.serverMs.max),
          ms(o.clientMs.p50),
          ms(o.clientMs.p95),
          ms(o.clientMs.max),
        ].join(" | "),
      )
      .map((row) => `| ${row} |`),
  ];
  return [...conditions, "", "All times are in milliseconds.", "", ...table].join("\n");
}

/** The value at a dotted path of a parsed record, or undefined. */
function at(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const key of path.split(".")) {
    if (typeof v !== "object" || v === null || !Object.hasOwn(v, key)) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

const TEXT_FIELDS = [
  "measuredAt",
  "commit",
  "machine.os",
  "machine.release",
  "machine.cpu",
  "runtime.wrangler",
  "runtime.workerd",
  "runtime.node",
  "storage",
] as const;
const COUNT_FIELDS = ["machine.cores", "machine.memoryGiB", "pbkdf2Iterations", "warmup"] as const;
const LOAD_FIELDS = ["load.before", "load.after"] as const;

const isTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The failures of one spread: each value a time, and p50 <= p95 <= max. */
function spreadFailures(route: string, side: string, s: unknown): string[] {
  const [p50, p95, max] = [at(s, "p50"), at(s, "p95"), at(s, "max")];
  if (!isTime(p50) || !isTime(p95) || !isTime(max)) return [`${route}: ${side} is not three times`];
  if (p50 > p95 || p95 > max) return [`${route}: ${side} is not p50 <= p95 <= max`];
  return [];
}

/**
 * The record of the run and the block of the page (plan 12h Task 15 rule 5).
 * `cores` is the core count of the machine that ran the measurement. The
 * check never runs the measurement: it holds the record of a person's run.
 */
export function checkPerformance(page: string, data: PerformanceData, cores: number): CheckReport {
  const failures: string[] = [];
  for (const f of TEXT_FIELDS) {
    const v = at(data, f);
    if (typeof v !== "string" || v.trim() === "")
      failures.push(`the condition ${f} is missing or empty`);
  }
  for (const f of COUNT_FIELDS) {
    const v = at(data, f);
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      failures.push(`the condition ${f} is missing or not a positive integer`);
  }
  for (const f of LOAD_FIELDS) {
    const v = at(data, f);
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isTime))
      failures.push(`the condition ${f} is missing or not three load averages`);
  }
  const commit = at(data, "commit");
  if (typeof commit === "string" && !/^[0-9a-f]{40}$/.test(commit))
    failures.push(`the commit ${commit} is not 40 hex characters`);
  // A loaded machine is not evidence: the run competes with other work.
  const before = at(data, "load.before");
  const first = Array.isArray(before) ? before[0] : undefined;
  if (isTime(first) && first > cores)
    failures.push(`the load before the run is ${first}, above the ${cores} cores`);

  const ops = at(data, "operations");
  const list = Array.isArray(ops) ? (ops as unknown[]) : [];
  if (!Array.isArray(ops)) failures.push("the record has no operations");
  const routes = list.map((o) => at(o, "route"));
  for (const r of MEASURED_ROUTES)
    if (!routes.includes(r)) failures.push(`the record has no operation ${r}`);
  let samples = 0;
  for (const o of list) {
    const route = String(at(o, "route"));
    if (!(MEASURED_ROUTES as readonly unknown[]).includes(at(o, "route")))
      failures.push(`the operation ${route} is not one of the measured routes`);
    const n = at(o, "samples");
    if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_SAMPLES)
      failures.push(`${route}: ${String(n)} samples; an operation needs at least ${MIN_SAMPLES}`);
    else samples += n;
    failures.push(...spreadFailures(route, "serverMs", at(o, "serverMs")));
    failures.push(...spreadFailures(route, "clientMs", at(o, "clientMs")));
  }

  const starts = page.split(MEASURED_START).length - 1;
  const ends = page.split(MEASURED_END).length - 1;
  const from = page.indexOf(MEASURED_START);
  const to = page.indexOf(MEASURED_END);
  if (starts !== 1 || ends !== 1 || to < from) {
    failures.push(`the page needs one ${MEASURED_START} and one ${MEASURED_END} after it`);
  } else {
    const block = page.slice(from + MEASURED_START.length, to);
    // A record with a missing field cannot render; that field already failed above.
    let want: string | null = null;
    try {
      want = `\n${renderPerformanceTable(data)}\n`;
    } catch {
      want = null;
    }
    if (want !== null && block !== want)
      failures.push("the block of the page differs from renderPerformanceTable(data)");
    const after = page
      .slice(to + MEASURED_END.length)
      .replace(/\s+/g, " ")
      .trim();
    const first = sentences(after)[0] ?? "";
    if (!first.startsWith(NOT_DEPLOYED))
      failures.push(`the first sentence under the table does not start with "${NOT_DEPLOYED}"`);
  }

  return requireCounts(
    { name: "check-performance", counts: { operations: list.length, samples }, failures },
    ["operations", "samples"],
  );
}
