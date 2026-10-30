import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SupportRow, supportTable } from "../../../apps/site/scripts/check-security-policy.ts";
import { entryKey } from "../../../apps/site/scripts/lib/feed.ts";
import { PRE_RELEASE_SENTENCES } from "../../../apps/site/src/data/unpublished.ts";
import { releasedNames } from "./lib/released.ts";
import type { Report } from "./lib/report.ts";
import { UNPUBLISHED_VERSION } from "./lib/unpublished.ts";
import { readWorkspace } from "./lib/workspace.ts";
import { type Exec, spawnExec, stripColours } from "./release-check.ts";
import { removeParagraph } from "./rewrite-unpublished.ts";

// The rehearsal of the version pull request (ruling 65 of plan 12j, C1 b).
// The version pull request of 0.1.0 failed its own gate, and no run of the
// lane had run the suite at the version state: the dry run runs no test
// (final review D of plan 12j, C1). This script makes that state in a copy of
// HEAD. It runs `changeset version`, the rewrite of the first release, and the
// scripted forms of the edits by hand, with the planned values of
// release/rehearsal.json. It runs the format at the first release only, and
// the lint of ci.yml at each release (ruling 77 of plan 12j). Then it runs
// release-check --no-osv --no-dry-run in the copy, through the test servers
// of the copy, and prints one summary line. It never commits, tags, pushes, or publishes, and it leaves the
// checkout unchanged.

/** The planned values of the next release, by the path from the root. */
export const PLAN_FILE = "release/rehearsal.json";

/** The file of RELEASE_DATES, by the path from the root. */
export const DATES_FILE = "apps/site/src/data/releases.ts";

/** The steps of the rehearsal, in order. It stops at the first step that fails. */
export const REHEARSAL_STEPS = [
  "copy",
  "install",
  "changeset version",
  "rewrite",
  "edits",
  "format",
  "lint",
  "release-check",
] as const;
export type RehearsalStep = (typeof REHEARSAL_STEPS)[number];

/**
 * The install of the copy. The tests of the copy need the install scripts of
 * the workspace, such as the native build of better-sqlite3, so it keeps
 * them, unlike the install of the release copy of the dry run.
 */
export const COPY_INSTALL: readonly string[] = [
  "pnpm",
  "install",
  "--frozen-lockfile",
  "--offline",
];

/** The rewrite of the pre-release texts: the command of the runbook step of the first release. */
export const COPY_REWRITE: readonly string[] = [
  "node",
  "scripts/release/src/rewrite-unpublished.ts",
];

/**
 * The format of the runbook step of the first release. The rewrite changes
 * many pages, and a rewritten cell can pass the line width of Biome. A later
 * release has no format step, so the copy runs it at the first release only.
 */
export const COPY_FORMAT: readonly string[] = ["pnpm", "format"];

/**
 * The lint of the job check of ci.yml, with no --write, after each edit.
 * Before, the copy ran the format at each release and no lint. So it could
 * not show a format fault of a later version pull request, which ci.yml
 * then fails (ruling 77 of plan 12j). --error-on-warnings fails a warning
 * too, which the lint of ci.yml lets pass.
 */
export const COPY_LINT: readonly string[] = ["pnpm", "lint", "--error-on-warnings"];

/** The release check in the copy, with the merge base of the version branch given by --base. */
export const copyCheck = (base: string): readonly string[] => [
  "node",
  "scripts/release/src/release-check.ts",
  "--no-osv",
  "--no-dry-run",
  "--base",
  base,
];

/** The planned values of the next release (release/rehearsal.json). */
export interface RehearsalPlan {
  /** The planned UTC time of the publish: the value of each new row of RELEASE_DATES. */
  publish: string;
  /** Each row of release/support.json after the release. A new minor writes them, and their table. */
  support: SupportRow[];
  /** The lines of the Resources page in the place of RESOURCES_EMPTY, at the first release. */
  resources: string[];
}

/**
 * The scripted form of each text of PRE_RELEASE_SENTENCES that the owner edits
 * by hand, by its file. "support" is the support table in the place of the
 * text, "resources" is the planned lines of the Resources page, and "remove"
 * removes the paragraph, as the owner does after the device checks. A text by
 * hand with no entry here fails the rehearsal, so a new one joins this list.
 */
export const HAND_EDITS: Readonly<Record<string, "support" | "resources" | "remove">> = {
  "SECURITY.md": "support",
  "apps/site/src/content/docs/docs/resources.md": "resources",
  "apps/site/src/content/docs/docs/reference/routes.md": "remove",
};

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["current", "security", "unsupported"];

/** The faults of the planned values. check-support and the site checks hold the rest in the copy. */
export function planFailures(plan: unknown): string[] {
  const at = PLAN_FILE;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan))
    return [`${at} is not a JSON object`];
  const p = plan as Record<string, unknown>;
  const failures: string[] = [];
  for (const key of Object.keys(p))
    if (!["publish", "support", "resources"].includes(key))
      failures.push(`${at} holds the key ${key}; it holds publish, support, and resources`);
  const publish = p.publish;
  const real =
    typeof publish === "string" &&
    TIME.test(publish) &&
    !Number.isNaN(Date.parse(publish)) &&
    new Date(publish).toISOString().replace(".000Z", "Z") === publish;
  if (!real) failures.push(`${at}: publish is not a real UTC time YYYY-MM-DDTHH:MM:SSZ`);
  if (!Array.isArray(p.support) || p.support.length === 0)
    failures.push(`${at}: support is not a list of rows`);
  else
    p.support.forEach((row: unknown, i) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const ok =
        typeof r.minor === "string" &&
        /^\d+\.\d+$/.test(r.minor) &&
        typeof r.status === "string" &&
        STATUSES.includes(r.status) &&
        typeof r.released === "string" &&
        DAY.test(r.released) &&
        Array.isArray(r.schemaFrom) &&
        r.schemaFrom.length > 0 &&
        r.schemaFrom.every((v) => Number.isInteger(v));
      if (!ok)
        failures.push(
          `${at}: support row ${i + 1} needs minor, status, released, and schemaFrom in the form of release/support.json`,
        );
    });
  const current = Array.isArray(p.support)
    ? (p.support as Record<string, unknown>[]).filter((r) => r?.status === "current")
    : [];
  if (Array.isArray(p.support) && current.length !== 1)
    failures.push(`${at}: support has ${current.length} rows with the status current, not 1`);
  if (
    !Array.isArray(p.resources) ||
    p.resources.length === 0 ||
    !p.resources.every((l) => typeof l === "string" && l.trim() !== "")
  )
    failures.push(`${at}: resources is not a list of lines`);
  return failures;
}

/** The planned values of the tree at `root`, or the failures of their read. */
export function readPlan(root: string): { plan: RehearsalPlan | null; failures: string[] } {
  const path = join(root, PLAN_FILE);
  if (!existsSync(path)) return { plan: null, failures: [`${PLAN_FILE} does not exist`] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { plan: null, failures: [`${PLAN_FILE} is not JSON`] };
  }
  const failures = planFailures(value);
  return { plan: failures.length === 0 ? (value as RehearsalPlan) : null, failures };
}

/** The literal of RELEASE_DATES in its file: the head, the rows, and the end. */
const DATES = /(export const RELEASE_DATES: Readonly<Record<string, string>> = \{)([^}]*)(\};)/;

/** The source of releases.ts with one row of `time` for each key, after the rows it holds. */
export function withReleaseDates(source: string, keys: readonly string[], time: string): string {
  const m = DATES.exec(source);
  if (m === null)
    throw new Error(
      `${DATES_FILE} has no RELEASE_DATES literal of the form that the rehearsal reads`,
    );
  const rows = (m[2] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  for (const key of keys) {
    if (rows.some((l) => l.startsWith(`${JSON.stringify(key)}:`)))
      throw new Error(`RELEASE_DATES already holds ${key}`);
    rows.push(`${JSON.stringify(key)}: ${JSON.stringify(time)},`);
  }
  const body = `${m[1]}\n${rows.map((l) => `  ${l}`).join("\n")}\n${m[3]}`;
  return source.replace(DATES, () => body);
}

/**
 * SECURITY.md with the support table of `rows`. At the first release the
 * table goes in the place of `first`, the text by hand. At a later minor it
 * goes in the place of the table of the section "Supported versions".
 */
export function withSupportTable(
  source: string,
  rows: readonly SupportRow[],
  first: string | null,
): string {
  const table = supportTable(rows);
  if (first !== null) {
    if (source.split(first).length !== 2)
      throw new Error(`SECURITY.md does not hold the text by hand once: ${first}`);
    return source.replace(first, () => table);
  }
  const lines = source.split("\n");
  const at = lines.indexOf("## Supported versions");
  const start = lines.findIndex((l, i) => i > at && l.startsWith("|"));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith("|"));
  if (at < 0 || start < 0 || lines.slice(at + 1, start).some((l) => l.startsWith("## ")))
    throw new Error('SECURITY.md has no table in the section "Supported versions"');
  lines.splice(start, (end < 0 ? lines.length : end) - start, ...table.split("\n"));
  return lines.join("\n");
}

/** The group version of the released packages of the tree at `root`, or the list of each version. */
function groupVersions(root: string): string[] {
  const names = new Set(releasedNames(root));
  return [
    ...new Set(
      readWorkspace(root)
        .filter((p) => names.has(p.name))
        .map((p) => p.manifest.version),
    ),
  ];
}

const minorOf = (version: string) => version.split(".").slice(0, 2).join(".");
const nonEmpty = (text: string) => text.split("\n").filter((l) => l.trim() !== "");
const firstLine = (r: { stdout: string; stderr: string }) =>
  (nonEmpty(r.stderr)[0] ?? nonEmpty(r.stdout).at(-1) ?? "no output").trim();

export interface RehearsalOptions {
  /** The checkout. The rehearsal reads it with git and never writes to it. */
  root: string;
  exec?: Exec;
  /** The parent of the temp folder. The default is the system temp folder. */
  tmp?: string;
  /** Keep the copy after the run. */
  keep?: boolean;
  /** Gets one line as each step starts. */
  log?: (line: string) => void;
}

export interface RehearsalReport extends Report {
  /** 0 PASS, 1 FAIL, 2 a dirty checkout. */
  exit: 0 | 1 | 2;
  /** The group version after changeset version, or null before it. */
  version: string | null;
  /** The first step that failed, or null. */
  stopped: RehearsalStep | null;
  /** True when the copy was at 0.0.0, so the edits of the first release ran. */
  first: boolean;
  /** The verdict of the lint in the copy. */
  lint: "PASS" | "FAIL" | "not-run";
  /** The verdict of release-check in the copy. */
  check: "PASS" | "FAIL" | "not-run";
  /** The copy, or null when the run stopped before it. */
  dir: string | null;
}

/**
 * The summary line: `release-rehearsal: PASS version=<v> first=<yes|no>
 * dates=<n> support=<n> resources=<n> removed=<n> lint=PASS release-check=PASS
 * failures=0`.
 */
export function rehearsalLine(r: RehearsalReport): string {
  const c = r.counts;
  const verdict = r.failures.length === 0 ? "PASS" : "FAIL";
  return `release-rehearsal: ${verdict} version=${r.version ?? "none"} first=${r.first ? "yes" : "no"} dates=${c.dates ?? 0} support=${c.support ?? 0} resources=${c.resources ?? 0} removed=${c.removed ?? 0} lint=${r.lint} release-check=${r.check} failures=${r.failures.length}`;
}

/**
 * The failure lines of a lint run, or none for a clean run. Biome prints each
 * diagnostic on stderr under a head of its place and category and a line of
 * "━", such as `apps/x.ts:2:3 lint/suspicious/noDebugger  FIXABLE  ━━━` or
 * `apps/x.ts format ━━━`. It prints the counts on stdout, such as `Found 1
 * error.` (Biome 2.5.15, read 2026-10-31). A count of errors or warnings
 * fails the run, also at exit 0. The last head, `check ━━━`, names no place.
 */
export function lintFailures(r: { status: number; stdout: string; stderr: string }): string[] {
  const lines = stripColours(`${r.stdout}\n${r.stderr}`).split(/\r?\n/);
  const found = lines
    .map((l) => l.trim())
    .filter((l) => /^Found \d+ (errors?|warnings?)\.$/.test(l));
  if (r.status === 0 && found.length === 0) return [];
  const heads = lines.flatMap((l) => {
    const m = /^(\S+) ([a-z][\w/]*)(?:\s+FIXABLE)?\s+━/.exec(l);
    return m === null ? [] : [`lint: ${m[1]} ${m[2]}`];
  });
  const counts = found.length > 0 ? found.join(" ") : "no count line";
  return [`lint: ${COPY_LINT.join(" ")} exited ${r.status}: ${counts}`, ...heads];
}

/**
 * The failure lines of a release-check run: each line after its summary line
 * that is no note, and each named vitest failure of the evidence run, such as
 * `authtempo-release: FAIL test/check-pack.test.ts > check-pack > ...`.
 */
export function checkFailures(output: string): { summary: string | null; failures: string[] } {
  const lines = stripColours(output).split(/\r?\n/);
  const at = lines.findIndex((l) => /^release-check: (PASS|FAIL) /.test(l));
  const failures: string[] = [];
  for (const l of lines) {
    const m = /^(\S+):test:\s+FAIL\s+(\S+\.test\.\w+ > .*\S)\s*$/.exec(l);
    if (m !== null) failures.push(`${m[1]}: FAIL ${m[2]}`);
  }
  if (at >= 0)
    for (const l of lines.slice(at + 1))
      if (l.startsWith("  ") && !l.trim().startsWith("note:")) failures.push(l.trim());
  return { summary: at < 0 ? null : (lines[at] ?? null), failures: [...new Set(failures)] };
}

/**
 * The rehearsal of the version pull request in a copy of HEAD under a new temp
 * folder. It stops at the first step that fails, and it takes the test
 * servers of the copy down after release-check.
 */
export async function rehearse(options: RehearsalOptions): Promise<RehearsalReport> {
  const exec = options.exec ?? spawnExec;
  const log = options.log ?? (() => {});
  const root = options.root;
  const counts = { dates: 0, support: 0, resources: 0, removed: 0 };
  const report: RehearsalReport = {
    name: "release-rehearsal",
    counts,
    failures: [],
    notes: [],
    exit: 0,
    version: null,
    stopped: null,
    first: false,
    lint: "not-run",
    check: "not-run",
    dir: null,
  };
  const { failures, notes } = report;
  const done = (exit: 0 | 1 | 2, step: RehearsalStep | null = null) => {
    report.stopped = failures.length > 0 ? step : null;
    report.exit = failures.length === 0 ? 0 : exit === 0 ? 1 : exit;
    if (step !== null && failures.length > 0)
      for (const later of REHEARSAL_STEPS.slice(REHEARSAL_STEPS.indexOf(step) + 1))
        notes.push(`not run: ${later}, after the failed ${step}`);
    return report;
  };

  const { plan, failures: planned } = readPlan(root);
  failures.push(...planned);
  if (plan === null) return done(1, "copy");

  // The copy is of HEAD, so a change that is not committed would not take part.
  // The plan is the one exception: the rehearsal reads it from the checkout,
  // so the owner can write the values of the next release with no commit.
  const status = await exec("git", ["status", "--porcelain"], root, false);
  if (status.status !== 0) {
    failures.push(`git status --porcelain exited ${status.status}: ${firstLine(status)}`);
    return done(2, "copy");
  }
  const dirty = nonEmpty(status.stdout)
    .filter((l) => l.slice(3) !== PLAN_FILE)
    .map((l) => l.trim());
  if (dirty.length > 0) {
    failures.push(
      `the checkout has changes that the copy of HEAD does not hold: ${dirty.join(", ")}`,
    );
    return done(2, "copy");
  }
  const head = await exec("git", ["rev-parse", "HEAD"], root, false);
  const base = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(base)) {
    failures.push(`git rev-parse HEAD exited ${head.status}: ${firstLine(head)}`);
    return done(1, "copy");
  }

  // The real path: a test of the copy compares the paths that it gets from
  // import.meta.url and from the cwd, and macOS links /var to /private/var.
  const temp = realpathSync(mkdtempSync(join(options.tmp ?? tmpdir(), "authtempo-rehearsal-")));
  const repo = join(temp, "repo");
  report.dir = repo;
  let servers = false;
  /** Runs one command. A command that exits other than 0 adds a failure and gives null. */
  const run = async (step: RehearsalStep, cmd: readonly string[], cwd = repo, echo = false) => {
    log(`release-rehearsal: ${step}: ${cmd.join(" ")}`);
    const r = await exec(cmd[0] ?? "", cmd.slice(1), cwd, echo);
    if (r.status === 0) return r;
    failures.push(`${step}: ${cmd.join(" ")} exited ${r.status}: ${firstLine(r)}`);
    return null;
  };

  try {
    // 1. The copy: a clone of the checkout at HEAD. Its own folder is a git
    // repository, so the test servers give it a slot of its own.
    if (!(await run("copy", ["git", "clone", "--quiet", "--no-checkout", root, repo], temp)))
      return done(1, "copy");
    if (!(await run("copy", ["git", "checkout", "--quiet", "--detach", base])))
      return done(1, "copy");

    // 2. The install.
    if (!(await run("install", COPY_INSTALL))) return done(1, "install");

    // 3. changeset version, as step 3 of the runbook.
    const names = releasedNames(repo);
    const before = groupVersions(repo);
    if (!(await run("changeset version", ["pnpm", "changeset", "version"])))
      return done(1, "changeset version");
    const after = groupVersions(repo);
    if (before.length !== 1 || after.length !== 1) {
      failures.push(
        `changeset version: the released packages hold the versions ${before.join(", ")} before and ${after.join(", ")} after, not one`,
      );
      return done(1, "changeset version");
    }
    const source = before[0] ?? "";
    const version = after[0] ?? "";
    report.version = version;
    if (version === source) {
      failures.push(
        `changeset version: the group stays at ${version}; no changeset names a released package`,
      );
      return done(1, "changeset version");
    }
    report.first = source === UNPUBLISHED_VERSION;

    // 4. The rewrite of the first release.
    if (report.first) {
      const r = await run("rewrite", COPY_REWRITE);
      if (r === null) return done(1, "rewrite");
      const summary = nonEmpty(r.stdout).find((l) => l.startsWith("rewrite-unpublished: "));
      if (summary?.startsWith("rewrite-unpublished: PASS ") !== true) {
        failures.push(`rewrite: printed no PASS line: ${summary ?? firstLine(r)}`);
        return done(1, "rewrite");
      }
      notes.push(summary);
    }

    // 5. The edits by hand of the runbook, from the planned values.
    log("release-rehearsal: edits");
    const read = (path: string) => readFileSync(join(repo, path), "utf8");
    const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
    try {
      // One row of RELEASE_DATES for each released package (step 4 of the runbook).
      const keys = names.map((name) => entryKey(name, version));
      write(DATES_FILE, withReleaseDates(read(DATES_FILE), keys, plan.publish));
      counts.dates = keys.length;
      const hand = PRE_RELEASE_SENTENCES.filter((e) => e.published === null);
      if (report.first)
        for (const e of hand)
          if (HAND_EDITS[e.file] === undefined)
            failures.push(
              `edits: HAND_EDITS has no scripted edit of the text by hand of ${e.file}`,
            );
      if (failures.length > 0) return done(1, "edits");
      // A new minor writes its support rows and their table (step 5 of the runbook).
      if (report.first || minorOf(version) !== minorOf(source)) {
        const row = plan.support.find(
          (r) => r.minor === minorOf(version) && r.status === "current",
        );
        if (row === undefined) {
          failures.push(
            `edits: ${PLAN_FILE} has no current support row for the minor ${minorOf(version)}`,
          );
          return done(1, "edits");
        }
        // Step 5 of the runbook writes the UTC day of the publish in released.
        const day = plan.publish.slice(0, 10);
        if (row.released !== day) {
          failures.push(
            `edits: the support row of ${row.minor} in ${PLAN_FILE} gives released ${row.released}; the day of publish is ${day}`,
          );
          return done(1, "edits");
        }
        write("release/support.json", `${JSON.stringify(plan.support, null, 2)}\n`);
        const first = report.first
          ? (hand.find((e) => HAND_EDITS[e.file] === "support")?.sentence ?? null)
          : null;
        write("SECURITY.md", withSupportTable(read("SECURITY.md"), plan.support, first));
        counts.support = plan.support.length;
      }
      // The texts by hand of "The first release" (step 6 of the runbook).
      if (report.first)
        for (const e of hand) {
          const kind = HAND_EDITS[e.file];
          if (kind === "support") continue;
          const text = read(e.file);
          if (text.split(e.sentence).length !== 2) {
            failures.push(
              `edits: ${e.file} does not hold the text by hand once: ${e.sentence.split("\n")[0]}`,
            );
            continue;
          }
          if (kind === "resources") {
            write(
              e.file,
              text.replace(e.sentence, () => plan.resources.join("\n")),
            );
            counts.resources = plan.resources.length;
          } else {
            const next = removeParagraph(text, e.sentence);
            if (next === null)
              failures.push(`edits: ${e.file}: the text by hand is not a whole paragraph`);
            else {
              write(e.file, next);
              counts.removed++;
            }
          }
        }
    } catch (error) {
      failures.push(`edits: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failures.length > 0) return done(1, "edits");

    // 6. The format of the runbook step of the first release, at that release only.
    if (report.first && !(await run("format", COPY_FORMAT))) return done(1, "format");

    // 7. The lint of ci.yml, after each edit. It fails on an error or a warning.
    log(`release-rehearsal: lint: ${COPY_LINT.join(" ")}`);
    const lint = await exec(COPY_LINT[0] ?? "", COPY_LINT.slice(1), repo, false);
    const lintFaults = lintFailures(lint);
    report.lint = lintFaults.length === 0 ? "PASS" : "FAIL";
    if (lintFaults.length > 0) {
      failures.push(...lintFaults);
      return done(1, "lint");
    }

    // 8. release-check, as the job check of ci.yml runs it on the pull request.
    // It starts the test servers of the copy, so the finally block takes them down.
    servers = true;
    const command = copyCheck(base);
    log(`release-rehearsal: release-check: ${command.join(" ")}`);
    const check = await exec(command[0] ?? "", command.slice(1), repo, true);
    const result = checkFailures(`${check.stdout}\n${check.stderr}`);
    if (result.summary === null) {
      report.check = "FAIL";
      failures.push(`release-check exited ${check.status} and printed no summary line`);
      return done(1, "release-check");
    }
    notes.push(result.summary);
    const pass = /^release-check: PASS .* failures=0$/.test(result.summary) && check.status === 0;
    report.check = pass ? "PASS" : "FAIL";
    if (!pass)
      failures.push(`release-check exited ${check.status}: ${result.summary}`, ...result.failures);
    return done(pass ? 0 : 1, "release-check");
  } finally {
    // The servers of the copy go down with the copy, so no set stays behind.
    if (servers) {
      const down = await exec("node", ["scripts/test-servers.mjs", "down"], repo, false);
      const line = nonEmpty(`${down.stdout}\n${down.stderr}`).at(-1)?.trim() ?? "no output";
      if (down.status !== 0) {
        failures.push(`test-servers down exited ${down.status}: ${line}`);
        report.exit = 1;
      } else notes.push(`test-servers down: ${line}`);
    }
    if (options.keep !== true) rmSync(temp, { recursive: true, force: true });
    else notes.push(`the copy stays at ${repo}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--keep");
  if (unknown.length > 0) {
    console.error(`release-rehearsal: unknown argument ${unknown[0]}; give --keep or nothing`);
    process.exit(2);
  }
  const report = await rehearse({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    keep: args.includes("--keep"),
    log: (line) => console.error(line),
  });
  console.log(rehearsalLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  for (const note of report.notes) console.log(`  note: ${note}`);
  process.exit(report.exit);
}
