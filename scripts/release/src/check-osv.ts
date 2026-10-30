import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readInput } from "./check-dependencies.ts";
import { type Report, requireCounts, summaryLine } from "./lib/report.ts";

/**
 * The OSV batch query. Its page (https://google.github.io/osv.dev/post-v1-querybatch/,
 * read 2026-10-20) says that the results come in the order of the queries.
 */
export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";

/**
 * The queries in one batch. The querybatch page (read 2026-10-20) gives no count
 * limit; plan 12j Task 7 sets 1000, so one large closure does not become one large request.
 */
const BATCH_SIZE = 1000;

/** The time that one batch may take before the check counts it as no answer. */
const TIMEOUT_MS = 20_000;

/** The longest life of an exemption after its read date (spec 33 item 9). */
const EXEMPTION_DAYS = 90;

/** The fetch seam: the entry passes globalThis.fetch, and a test passes a fake. */
export type OsvQuery = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** One entry of release/osv-exempt.json. The owner writes each one. */
export interface OsvExemption {
  /** The OSV id of the advisory. */
  id: string;
  name: string;
  version: string;
  reason: string;
  /** The date that the owner read the advisory (YYYY-MM-DD). */
  read: string;
  /** The last day of the exemption, at most 90 days after `read` (YYYY-MM-DD). */
  expires: string;
}

export interface OsvInput {
  closure: readonly { name: string; version: string }[];
  exempt: readonly OsvExemption[];
  query: OsvQuery;
  /** The date of the run (YYYY-MM-DD). */
  today: string;
  url?: string;
  timeoutMs?: number;
}

const days = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** One batch through the seam. It throws a reason when no full answer comes. */
async function queryBatch(
  input: OsvInput,
  batch: readonly { name: string; version: string }[],
): Promise<{ vulns?: { id: string }[]; next_page_token?: string }[]> {
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer in ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    // Only the public name and version of each package leave the machine.
    const body = JSON.stringify({
      queries: batch.map((p) => ({
        package: { name: p.name, ecosystem: "npm" },
        version: p.version,
      })),
    });
    const answer = await Promise.race([
      (async () => {
        const response = await input.query(input.url ?? OSV_BATCH_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (response.status !== 200) throw new Error(`status ${response.status}`);
        return (await response.json()) as { results?: unknown };
      })(),
      late,
    ]);
    const results = Array.isArray(answer.results) ? answer.results : [];
    if (results.length !== batch.length)
      throw new Error(`${results.length} results for ${batch.length} queries`);
    return results as { vulns?: { id: string }[]; next_page_token?: string }[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Each package of the runtime closure has no open advisory in OSV, or a live
 * exemption for it (spec 33 item 9). No answer from OSV is a failure.
 */
export async function checkOsv(input: OsvInput): Promise<Report> {
  const failures: string[] = [];
  const packages = [...new Map(input.closure.map((p) => [`${p.name}@${p.version}`, p])).values()];

  const notes: string[] = [];
  const url = input.url ?? OSV_BATCH_URL;
  // A fake server can answer "no advisory" for each query. The summary line
  // does not show the URL, so this note tells the reader of the log.
  if (url !== OSV_BATCH_URL)
    notes.push(`OSV_URL is ${url}, not ${OSV_BATCH_URL}: this run did not ask OSV`);

  // Each exemption holds a reason, a date range, and a package of the closure,
  // used or not, so the file stays true. A read date after today or after the
  // expiry would stretch the 90 days.
  const live = new Set<string>();
  for (const e of input.exempt) {
    const at = `${e.id}: the exemption for ${e.name}@${e.version}`;
    let ok = true;
    if (typeof e.reason !== "string" || e.reason.trim() === "") {
      failures.push(`${at} has no reason`);
      ok = false;
    }
    if (!packages.some((p) => p.name === e.name && p.version === e.version)) {
      failures.push(`${at} matches no package of the runtime closure, so it is stale`);
      ok = false;
    }
    if (Number.isNaN(days(e.read)) || Number.isNaN(days(e.expires))) {
      failures.push(`${at} has no read date or expiry in the form YYYY-MM-DD`);
      ok = false;
    } else if (days(e.read) > days(input.today)) {
      failures.push(`${at} has the read date ${e.read}, after today ${input.today}`);
      ok = false;
    } else if (days(e.read) > days(e.expires)) {
      failures.push(`${at} has the read date ${e.read}, after its expiry ${e.expires}`);
      ok = false;
    } else if (days(e.expires) < days(input.today)) {
      failures.push(`${at} expired on ${e.expires}`);
      ok = false;
    } else if (days(e.expires) - days(e.read) > EXEMPTION_DAYS) {
      failures.push(
        `${at} expires on ${e.expires}, more than ${EXEMPTION_DAYS} days after its read date ${e.read}`,
      );
      ok = false;
    }
    if (ok) live.add(`${e.id}\0${e.name}@${e.version}`);
  }

  let advisories = 0;
  let exempt = 0;
  /** Each advisory id that OSV returned, with its package. */
  const returned = new Set<string>();
  let answered = true;
  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE);
    let results: Awaited<ReturnType<typeof queryBatch>>;
    try {
      results = await queryBatch(input, batch);
    } catch (error) {
      failures.push(
        `no answer from OSV is not a pass: ${error instanceof Error ? error.message : String(error)}`,
      );
      answered = false;
      break;
    }
    batch.forEach((p, j) => {
      const result = results[j] ?? {};
      const at = `${p.name}@${p.version}`;
      for (const vuln of result.vulns ?? []) {
        advisories += 1;
        returned.add(`${vuln.id}\0${at}`);
        if (live.has(`${vuln.id}\0${at}`)) exempt += 1;
        else failures.push(`${vuln.id}: an open advisory for ${at} with no live exemption`);
      }
      if (result.next_page_token !== undefined)
        failures.push(`${at}: OSV holds more advisories than one page; read them at osv.dev`);
    });
  }

  // An exemption of an advisory that OSV did not return for its package and
  // version exempts nothing. It stays in the file as a stale claim, such as
  // after a fix or a wrong id (ruling 64 of plan 12j, Minor 3).
  if (answered)
    for (const e of input.exempt)
      if (
        live.has(`${e.id}\0${e.name}@${e.version}`) &&
        !returned.has(`${e.id}\0${e.name}@${e.version}`)
      )
        failures.push(
          `${e.id}: the exemption for ${e.name}@${e.version} names an advisory that OSV did not return for that package and version, so it is stale`,
        );

  return requireCounts(
    {
      name: "check-osv",
      counts: { packages: packages.length, advisories, exempt },
      failures,
      notes,
    },
    ["packages"],
  );
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = await checkOsv({
    closure: readInput(root).closure,
    exempt: JSON.parse(
      readFileSync(join(root, "release/osv-exempt.json"), "utf8"),
    ) as OsvExemption[],
    query: globalThis.fetch,
    today: new Date().toISOString().slice(0, 10),
    // OSV_URL exists only for the break test of plan 12j Task 7: an address with
    // no server proves that no answer is a failure. A release run never sets it,
    // and the check prints a note when it is set to another URL.
    ...(process.env.OSV_URL === undefined ? {} : { url: process.env.OSV_URL }),
  });
  console.log(summaryLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  for (const note of report.notes) console.log(`  note: ${note}`);
  if (report.failures.length > 0) process.exit(1);
}
