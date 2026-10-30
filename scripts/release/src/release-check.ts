import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { loadavg, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OSV_BATCH_URL } from "./check-osv.ts";
import { releasedNames } from "./lib/released.ts";
import type { Report } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

// The release check of spec 33 item 12 (plan 12j Task 14). A release that
// cannot prove its evidence does not ship. It runs four steps in order and
// stops at the first step that fails: the evidence run, the conformance
// counts, the release checks, and the dry run. Each step reads the summary
// lines that its commands print, never an exit code alone.

/** The output of one child process. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * The seam of each child process. `echo` copies the output to the output of
 * this process as it comes, so a person sees the evidence run. The test replaces it.
 */
export type Exec = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  echo: boolean,
) => Promise<RunResult>;

/** The oldest and the newest change time of the files under a folder, or null when it has none. */
export type Stat = (dir: string) => { files: number; oldest: number; newest: number } | null;

/** The steps of spec 33 item 12, in order. */
export const STEPS = ["evidence run", "conformance counts", "release checks", "dry run"] as const;
export type Step = (typeof STEPS)[number];

/**
 * The evidence run of spec 33 item 12.1, with the cache off. It runs through
 * the test servers of the checkout, as `pnpm test` does: without their
 * variables, each test that needs a server stops. --continue lets each task
 * report, so the log names each failure and not only the first one.
 */
export const EVIDENCE_RUN = [
  "node",
  "scripts/test-servers.mjs",
  "run",
  "--",
  "pnpm",
  "turbo",
  "run",
  "test",
  "typecheck",
  "typecheck:configs",
  "--force",
  "--continue",
] as const;

/**
 * The release checks of scripts/release that run alone, in the order of spec
 * 33 item 12.3. `base` takes the ref of --base. check-pack, check-tag,
 * prepare, and publish need tarballs, a tag, or a release copy, so the dry run
 * and release.yml run them.
 */
export const CHECKS: readonly { name: string; base?: true }[] = [
  { name: "check-packages" },
  { name: "check-changesets", base: true },
  { name: "check-records", base: true },
  { name: "check-deprecations" },
  { name: "check-dependencies" },
  { name: "check-workflows" },
  { name: "check-support" },
  { name: "check-osv" },
];

/** The check of the site that the site run prints (spec 33 item 12.3). */
export const SITE_CHECK = "check-security-policy";

/** The vitest reporter of the conformance counts (plan 12g, ruling 7). */
const REPORTER = "conformance-count-reporter";

/** Removes the colour codes of a terminal, which Turbo and vitest can write into a log. */
export function stripColours(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character starts each code.
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** One line of a task: `<package>:<task>: <text>`. A task name can hold a colon. */
const TASK_LINE = /^(\/\/|@[\w.-]+\/[\w.-]+|[\w.-]+):([\w:-]+): ?(.*)$/;

/** Each line of each task block, by `<package>:<task>`. */
export function taskBlocks(text: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const raw of stripColours(text).split(/\r?\n/)) {
    const m = TASK_LINE.exec(raw);
    if (m === null) continue;
    const key = `${m[1]}:${m[2]}`;
    const lines = blocks.get(key) ?? [];
    lines.push(m[3] ?? "");
    blocks.set(key, lines);
  }
  return blocks;
}

/** The counts of one vitest summary line, such as `Tests  1 failed | 385 passed (386)`. */
function vitestCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const part of text.replace(/\(\d+\)\s*$/, "").split("|")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(part);
    if (m?.[1] !== undefined && m[2] !== undefined) counts[m[2]] = Number(m[1]);
  }
  return counts;
}

/** A summary line of a check or a proof: `<name>: PASS|FAIL ...`. */
const CHECK_LINE = /^([\w@/.-]+): (PASS|FAIL)\b(.*)$/;

/**
 * Reads the log of the evidence run. The Turbo summary must read 0 cached
 * and each task successful. Each package with a test script has its
 * `<package>:test` block, and the block has a summary line with no failure: a
 * vitest summary, or a `<name>: PASS` line. Each failure count comes from a
 * summary line, never from a count of failure lines. `withTest` comes from the
 * workspace, never from a fixed list.
 */
export function readTurboRun(
  text: string,
  withTest: readonly string[],
  more: { withTypecheck?: readonly string[]; configs?: boolean } = {},
): Report {
  const failures: string[] = [];
  const notes: string[] = [];
  const clean = stripColours(text);
  const blocks = taskBlocks(clean);

  const tasks = / Tasks:\s+(\d+) successful, (\d+) total/.exec(clean);
  const cached = /Cached:\s+(\d+) cached, (\d+) total/.exec(clean);
  const successful = Number(tasks?.[1] ?? 0);
  const total = Number(tasks?.[2] ?? 0);
  const cachedCount = Number(cached?.[1] ?? 0);
  if (tasks === null)
    failures.push("the log has no Turbo summary line (Tasks: <n> successful, <n> total)");
  else if (successful !== total)
    failures.push(`Turbo ran ${successful} of ${total} tasks successfully`);
  if (cached === null)
    failures.push("the log has no Turbo cache line (Cached: <n> cached, <n> total)");
  else if (cachedCount > 0)
    failures.push(`the run has ${cachedCount} cached tasks; a cached task is not evidence`);
  for (const m of clean.matchAll(/^\s*Failed:\s+(.+?)\s*$/gm))
    failures.push(`Turbo failed: ${m[1]}`);
  for (const m of clean.matchAll(/^(\S+#[\w:-]+): +ERROR\b\s*(.*?)\s*$/gm))
    failures.push(`${m[1]}: ERROR ${m[2]}`);

  let reported = 0;
  let files = 0;
  let tests = 0;
  let skipped = 0;
  for (const name of withTest) {
    const block = blocks.get(`${name}:test`);
    if (block === undefined) {
      failures.push(`${name} has a test script and no ${name}:test block; it did not report`);
      continue;
    }
    const summaries: string[] = [];
    let checks = 0;
    let bad = false;
    for (const line of block) {
      const vitest = /^\s*(Test Files|Tests|Errors)\s{2,}(.+)$/.exec(line);
      if (vitest?.[1] !== undefined && vitest[2] !== undefined) {
        const kind = vitest[1];
        const counts = vitestCounts(vitest[2]);
        const failed =
          (counts.failed ?? 0) +
          (kind === "Errors" ? (counts.error ?? 0) + (counts.errors ?? 0) : 0);
        summaries.push(`${kind} ${vitest[2].trim()}`);
        if (kind === "Test Files") files += counts.passed ?? 0;
        if (kind === "Tests") {
          tests += counts.passed ?? 0;
          skipped += (counts.skipped ?? 0) + (counts.todo ?? 0);
        }
        if (failed > 0) {
          failures.push(`${name}:test: ${kind} ${vitest[2].trim()}`);
          bad = true;
        }
        continue;
      }
      const check = CHECK_LINE.exec(line.trim());
      if (check?.[1] === undefined) continue;
      checks++;
      const count = /\bfailures=(\d+)\b/.exec(check[3] ?? "");
      if (check[2] === "FAIL" || Number(count?.[1] ?? 0) > 0) {
        failures.push(`${name}:test: ${line.trim()}`);
        bad = true;
      }
    }
    if (summaries.length === 0 && checks === 0) {
      failures.push(`${name}:test printed no summary line`);
      continue;
    }
    if (!bad) reported++;
    // One note for each package: its vitest summaries and the count of its check lines.
    if (checks > 0) summaries.push(`${checks} check lines`);
    notes.push(`${name}: ${summaries.join("; ")}`);
  }

  for (const name of more.withTypecheck ?? [])
    if (!blocks.has(`${name}:typecheck`))
      failures.push(
        `${name} has a typecheck script and no ${name}:typecheck block; it did not report`,
      );
  if (more.configs === true) {
    const line = (blocks.get("//:typecheck:configs") ?? [])
      .map((l) => /typecheck:configs checked (\d+) vitest config files \(minimum (\d+)\)/.exec(l))
      .find((m) => m !== null);
    if (line?.[1] === undefined) failures.push("//:typecheck:configs printed no count line");
    else
      notes.push(`typecheck:configs checked ${line[1]} vitest config files (minimum ${line[2]})`);
  }
  if (skipped > 0) notes.push(`${skipped} tests skipped or todo, by the vitest summary lines`);

  return {
    name: "evidence run",
    counts: {
      tasks: successful,
      total,
      cached: cachedCount,
      packages: reported,
      withTest: withTest.length,
      files,
      tests,
    },
    failures,
    notes,
  };
}

/**
 * Reads the conformance counts of the evidence run (spec 33 item 12.2). Each
 * run of the reporter prints `conformance: <suite> tests=<n> passed=<n>`. A
 * suite with a test that did not pass fails, and so does a line of the
 * reporter that names a missing run. Each package in `reporters` runs the
 * reporter, and it reports at least one suite, or it fails.
 */
export function readConformance(text: string, reporters: readonly string[]): Report {
  const failures: string[] = [];
  const notes: string[] = [];
  let suites = 0;
  let packages = 0;
  const blocks = taskBlocks(text);
  for (const [key, lines] of blocks) {
    if (!key.endsWith(":test")) continue;
    const name = key.slice(0, -":test".length);
    let found = 0;
    for (const line of lines) {
      const m = /^conformance: (.+) tests=(\d+) passed=(\d+)\s*$/.exec(line.trim());
      if (m !== null) {
        found++;
        const [count, passed] = [Number(m[2]), Number(m[3])];
        if (count === 0 || passed < count)
          failures.push(`${name}: the suite ${m[1]} passed ${passed} of ${count} tests`);
        continue;
      }
      if (
        /^conformance: .*(is missing|has no passed test|passed \d+ of \d+ tests|a filtered run)/.test(
          line.trim(),
        )
      )
        failures.push(`${name}: ${line.trim()}`);
    }
    suites += found;
    if (found > 0) {
      packages++;
      notes.push(`${name}: ${found} conformance suites`);
    }
  }
  for (const name of reporters) {
    const lines = blocks.get(`${name}:test`) ?? [];
    if (!lines.some((l) => /^conformance: .+ tests=\d+ passed=\d+\s*$/.test(l.trim())))
      failures.push(`${name} runs the conformance reporter and reported no suite`);
  }
  if (suites === 0) failures.push("read 0 conformance suites");
  return {
    name: "conformance counts",
    counts: { suites, packages, reporters: reporters.length },
    failures,
    notes,
  };
}

/**
 * The build is newer than the change (spec 33 item 12.1): for each released
 * package, the oldest file of dist is newer than the newest file of src. A
 * build empties dist first, so each dist file comes from the last build.
 */
export function buildFailures(
  packages: readonly { name: string; dir: string }[],
  stat: Stat,
): string[] {
  const failures: string[] = [];
  for (const p of packages) {
    const dist = stat(join(p.dir, "dist"));
    const src = stat(join(p.dir, "src"));
    if (dist === null) failures.push(`${p.name}: no file in dist; the build did not run`);
    else if (src !== null && dist.oldest < src.newest)
      failures.push(
        `${p.name}: dist (oldest ${new Date(dist.oldest).toISOString()}) is older than src (newest ${new Date(src.newest).toISOString()}); the build is older than the change`,
      );
  }
  return failures;
}

/** The change times of the files under `dir`, without node_modules. */
export const fileStat: Stat = (dir) => {
  if (!existsSync(dir)) return null;
  let files = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (entry.isFile()) {
        const t = statSync(path).mtimeMs;
        files++;
        oldest = Math.min(oldest, t);
        newest = Math.max(newest, t);
      }
    }
  };
  walk(dir);
  return files === 0 ? null : { files, oldest, newest };
};

/** The summary line of a check in `stdout`, and the failure lines after it. */
function checkReport(name: string, stdout: string): { summary: string; failures: string[] } | null {
  const lines = stripColours(stdout).split(/\r?\n/);
  const at = lines.findIndex(
    (l) => l.startsWith(`${name}: PASS `) || l.startsWith(`${name}: FAIL `),
  );
  if (at < 0) return null;
  const failures = lines
    .slice(at + 1)
    .filter((l) => l.startsWith("  ") && !l.trim().startsWith("note:"))
    .map((l) => l.trim());
  return { summary: lines[at] ?? "", failures };
}

export interface ReleaseCheckOptions {
  /** The checkout. */
  root: string;
  exec?: Exec;
  stat?: Stat;
  /** The load averages of 1, 5, and 15 minutes. */
  load?: () => number[];
  /** The time since the machine started, in seconds. */
  uptime?: () => number;
  /** False with --no-osv: check-osv prints as not run. */
  osv?: boolean;
  /** False with --no-dry-run: the dry run prints as not run. */
  dryRun?: boolean;
  /** The ref of check-changesets and check-records: --base, or main. */
  base?: string;
  /** The env that the OSV rule reads. The default is process.env. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface ReleaseCheckReport extends Report {
  /** The first step that failed, or null. */
  stopped: Step | null;
  /** not-run with --no-dry-run, or after an earlier step failed. */
  dryRun: "PASS" | "FAIL" | "not-run";
  /** The 1-minute load average at the start. */
  load: number;
}

/** The summary line: `release-check: PASS tasks=<n> of <n> cached=0 packages=<p> of <p> checks=<c> of <c> dry-run=PASS load=<l>`. */
export function releaseCheckLine(r: ReleaseCheckReport): string {
  const c = r.counts;
  const verdict = r.failures.length === 0 ? "PASS" : "FAIL";
  return `release-check: ${verdict} tasks=${c.tasks ?? 0} of ${c.total ?? 0} cached=${c.cached ?? 0} packages=${c.packages ?? 0} of ${c.withTest ?? 0} checks=${c.checks ?? 0} of ${c.checksTotal ?? 0} dry-run=${r.dryRun} load=${r.load.toFixed(2)} failures=${r.failures.length}`;
}

const formatLoad = (l: number[]) => l.map((v) => v.toFixed(2)).join(" ");

/** Each child process through node:child_process, with the env of this process. */
export const spawnExec: Exec = (cmd, args, cwd, echo) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (echo) process.stdout.write(d);
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
      if (echo) process.stderr.write(d);
    });
    child.on("error", (error) =>
      resolve({ status: 127, stdout, stderr: `${stderr}${String(error)}` }),
    );
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });

/** The packages of the workspace that run the conformance reporter in a vitest config of their folder. */
export function reporterPackages(root: string): string[] {
  return readWorkspace(root)
    .filter((p) =>
      readdirSync(join(root, p.dir))
        .filter((f) => /^vitest(\.[\w-]+)?\.config\.[cm]?[jt]s$/.test(f))
        .some((f) => readFileSync(join(root, p.dir, f), "utf8").includes(REPORTER)),
    )
    .map((p) => p.name)
    .sort();
}

/**
 * The release check of spec 33 item 12. It runs the steps in order and stops
 * at the first step that fails. A step after it, and a check that --no-osv or
 * --no-dry-run skips, prints as not run, never as passed.
 */
export async function releaseCheck(options: ReleaseCheckOptions): Promise<ReleaseCheckReport> {
  const root = options.root;
  const exec = options.exec ?? spawnExec;
  const stat = options.stat ?? fileStat;
  const log = options.log ?? (() => {});
  const env = options.env ?? process.env;
  const start = (options.load ?? loadavg)();
  const failures: string[] = [];
  const notes: string[] = [];
  const counts: Record<string, number> = {
    tasks: 0,
    total: 0,
    cached: 0,
    packages: 0,
    withTest: 0,
    checks: 0,
    checksTotal: CHECKS.length + 1,
  };
  const report: ReleaseCheckReport = {
    name: "release-check",
    counts,
    failures,
    notes,
    stopped: null,
    dryRun: "not-run",
    load: start[0] ?? 0,
  };
  const seconds = (options.uptime ?? uptime)();
  notes.push(
    `uptime ${Math.floor(seconds / 86_400)} days ${Math.floor((seconds % 86_400) / 3600)} hours, load ${formatLoad(start)} at the start`,
  );
  const finish = () => {
    notes.push(`load ${formatLoad((options.load ?? loadavg)())} at the end`);
    return report;
  };
  const stop = (step: Step) => {
    report.stopped = step;
    for (const later of STEPS.slice(STEPS.indexOf(step) + 1))
      notes.push(`not run: ${later}, after the failed ${step}`);
    return finish();
  };

  const workspace = readWorkspace(root);
  // The packages of each script come from the workspace, never from a fixed list.
  const withScript = (key: string) =>
    workspace
      .filter(
        (p) =>
          typeof (p.manifest.scripts as Record<string, unknown> | undefined)?.[key] === "string",
      )
      .map((p) => p.name)
      .sort();
  const withTest = withScript("test");
  const withTypecheck = withScript("typecheck");
  const released = new Set(releasedNames(root));

  // 1. The evidence run.
  log(`release-check: ${EVIDENCE_RUN.join(" ")}`);
  const [cmd = "", ...args] = EVIDENCE_RUN;
  const evidence = await exec(cmd, args, root, true);
  const evidenceLog = `${evidence.stdout}\n${evidence.stderr}`;
  const run = readTurboRun(evidenceLog, withTest, {
    withTypecheck,
    configs: true,
  });
  for (const key of ["tasks", "total", "cached", "packages", "withTest"])
    counts[key] = run.counts[key] ?? 0;
  notes.push(...run.notes);
  failures.push(...run.failures);
  if (evidence.status !== 0 && run.failures.length === 0)
    failures.push(`the evidence run exited ${evidence.status}, and its log names no failure`);
  failures.push(
    ...buildFailures(
      workspace
        .filter((p) => released.has(p.name))
        .map((p) => ({ name: p.name, dir: join(root, p.dir) })),
      stat,
    ),
  );
  if (failures.length > 0) return stop("evidence run");

  // 2. The conformance counts, from the same log.
  const conformance = readConformance(evidenceLog, reporterPackages(root));
  notes.push(
    `conformance: suites=${conformance.counts.suites} packages=${conformance.counts.packages} reporters=${conformance.counts.reporters}`,
  );
  failures.push(...conformance.failures);
  if (failures.length > 0) return stop("conformance counts");

  // 3. The release checks, each alone, and the site check from the site run.
  const base = options.base ?? "main";
  const osvUrl = env.OSV_URL;
  for (const check of CHECKS) {
    if (check.name === "check-osv") {
      if (options.osv === false) {
        notes.push("not run: check-osv (--no-osv)");
        continue;
      }
      // A server that answers an empty result for each package would make check-osv pass on nothing.
      if (osvUrl !== undefined && osvUrl !== OSV_BATCH_URL) {
        failures.push(`check-osv: OSV_URL is ${osvUrl}; release-check reads only ${OSV_BATCH_URL}`);
        continue;
      }
    }
    log(`release-check: ${check.name}`);
    const path = `scripts/release/src/${check.name}.ts`;
    const r = await exec("node", check.base === true ? [path, base] : [path], root, false);
    const read = checkReport(check.name, r.stdout);
    if (read === null) {
      failures.push(`${check.name} exited ${r.status} and printed no summary line`);
      continue;
    }
    notes.push(read.summary);
    if (
      r.status !== 0 ||
      !read.summary.startsWith(`${check.name}: PASS `) ||
      !/ failures=0$/.test(read.summary)
    ) {
      failures.push(`${check.name} exited ${r.status}: ${read.summary}`);
      for (const line of read.failures) failures.push(`${check.name}: ${line}`);
      continue;
    }
    counts.checks = (counts.checks ?? 0) + 1;
  }
  const site = [...taskBlocks(evidenceLog)]
    .filter(([key]) => key.endsWith(":test"))
    .flatMap(([, lines]) =>
      lines.filter((l) => l.trim().startsWith(`${SITE_CHECK}: `)).map((l) => l.trim()),
    );
  if (site.length !== 1)
    failures.push(`the site run printed ${site.length} ${SITE_CHECK} lines, not 1`);
  else if (!site[0]?.startsWith(`${SITE_CHECK}: PASS `) || !/ failures=0$/.test(site[0]))
    failures.push(`the site run: ${site[0]}`);
  else {
    notes.push(site[0]);
    counts.checks = (counts.checks ?? 0) + 1;
  }
  if (failures.length > 0) return stop("release checks");

  // 4. The dry run, with its SHA-256 line of each tarball.
  if (options.dryRun === false) {
    notes.push("not run: dry run (--no-dry-run)");
    return finish();
  }
  log("release-check: dry run");
  const dry = await exec("node", ["scripts/release/src/dry-run.ts"], root, false);
  const lines = stripColours(dry.stdout).split(/\r?\n/);
  const summary = lines.find((l) => l.startsWith("release-dry-run: "));
  const shas = lines.filter((l) => /^\S+@\S+ [0-9a-f]{64} files=\d+$/.test(l));
  const m =
    summary === undefined
      ? null
      : /^release-dry-run: PASS packages=(\d+) of (\d+) .* failures=0$/.exec(summary);
  if (summary === undefined)
    failures.push(`the dry run exited ${dry.status} and printed no summary line`);
  else if (dry.status !== 0 || m === null || m[1] !== m[2]) {
    failures.push(`the dry run exited ${dry.status}: ${summary}`);
    for (const l of lines.slice(lines.indexOf(summary) + 1))
      if (l.startsWith("  ") && !l.trim().startsWith("note:"))
        failures.push(`dry run: ${l.trim()}`);
  } else if (shas.length !== released.size || Number(m[2]) !== released.size)
    failures.push(
      `the dry run printed ${shas.length} SHA-256 lines for ${released.size} released packages`,
    );
  notes.push(...shas, ...(summary === undefined ? [] : [summary]));
  notes.push(
    ...lines
      .filter((l) => l.trim().startsWith("note: check-pack:"))
      .map((l) => `dry run ${l.trim()}`),
  );
  report.dryRun = failures.length === 0 ? "PASS" : "FAIL";
  if (failures.length > 0) return stop("dry run");
  return finish();
}

/** The options of the command line: --no-osv, --no-dry-run, and --base <ref>. */
export function parseArgs(argv: readonly string[]): {
  osv: boolean;
  dryRun: boolean;
  base: string;
} {
  const out = { osv: true, dryRun: true, base: "main" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-osv") out.osv = false;
    else if (a === "--no-dry-run") out.dryRun = false;
    else if (a === "--base" && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("--"))
      out.base = argv[++i] ?? out.base;
    else
      throw new Error(
        `release-check: unknown argument ${a}; give --no-osv, --no-dry-run, or --base <ref>`,
      );
  }
  return out;
}

if (import.meta.main) {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const report = await releaseCheck({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    ...args,
    log: (line) => console.error(line),
  });
  console.log(releaseCheckLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  for (const note of report.notes) console.log(`  note: ${note}`);
  process.exit(report.failures.length > 0 ? 1 : 0);
}
