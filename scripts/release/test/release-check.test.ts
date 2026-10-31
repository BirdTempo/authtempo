import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OSV_BATCH_URL } from "../src/check-osv.ts";
import { UNPUBLISHED_CODE } from "../src/lib/unpublished.ts";
import {
  buildFailures,
  CHECK_EXEMPT,
  CHECKS,
  EVIDENCE_RUN,
  type Exec,
  parseArgs,
  proofRun,
  proofTests,
  type RunResult,
  readConformance,
  readTurboRun,
  releaseCheck,
  releaseCheckLine,
  reporterPackages,
  type Stat,
  stripColours,
} from "../src/release-check.ts";

const fixture = (path: string) => fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));

/**
 * A real log of this branch, with its colour codes: `node scripts/test-servers.mjs
 * run -- pnpm turbo run test typecheck typecheck:configs --force`, filtered to
 * `//` and the five packages of fixtures/release-check (2026-10-30). Each
 * failing log below is this log with one change.
 */
const PASS = readFileSync(fixture("turbo-logs/pass.txt"), "utf8");
/**
 * Two real logs of a GitHub runner's env, 2026-10-30: `CI=true
 * GITHUB_ACTIONS=true node scripts/test-servers.mjs run -- pnpm turbo run test
 * typecheck typecheck:configs --force --continue --filter=//
 * --filter=@authtempo/breach-check`, with --log-prefix=task and without it.
 * The path of the worktree became /work/authtempo.
 */
const GITHUB_TASK = readFileSync(fixture("turbo-logs/github-task.txt"), "utf8");
const GITHUB_AUTO = readFileSync(fixture("turbo-logs/github-auto.txt"), "utf8");
/** The workspace of the run: the five packages, each with a test and a typecheck script. */
const ROOT = fixture("release-check");
const WITH_TEST = [
  "@authtempo/adapter-sqlite",
  "@authtempo/breach-check",
  "@authtempo/site",
  "authtempo-example-node",
  "authtempo-release",
];
const read = (text: string) =>
  readTurboRun(text, WITH_TEST, { withTypecheck: WITH_TEST, configs: true });

/** The log with one change: `from` occurs exactly once, and `to` takes its place. */
function change(from: string, to: string): string {
  const parts = PASS.split(from);
  if (parts.length !== 2) throw new Error(`the log holds ${parts.length - 1} copies of ${from}`);
  return parts.join(to);
}

/** The log without each line of one task block. */
function withoutBlock(key: string): string {
  const lines = PASS.split("\n");
  const kept = lines.filter((l) => !stripColours(l).startsWith(`${key}: `));
  if (kept.length === lines.length) throw new Error(`the log has no block ${key}`);
  return kept.join("\n");
}

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
/** The vitest summary of one proof test run by its title: one test passes, and the rest of its file skips. */
const PROOF_PASS = " Test Files  1 passed (1)\n      Tests  1 passed | 11 skipped (12)\n";
const SHA = "a".repeat(64);
const DRY_RUN = [
  `@authtempo/adapter-sqlite@0.1.0 ${SHA} files=40`,
  `@authtempo/breach-check@0.1.0 ${SHA} files=6`,
  "release-dry-run: PASS packages=2 of 2 version=0.1.0 tarballs=2 files=46 smoke=2 failures=0",
].join("\n");

/** A fake of each child process: the real log, a PASS line for each check, and a passing dry run. */
function fakeExec(change: Record<string, (args: readonly string[]) => RunResult> = {}) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args, _cwd, echo) => {
    const label = args.includes("-t")
      ? "proof"
      : cmd === EVIDENCE_RUN[0] && args[0] === EVIDENCE_RUN[1]
        ? "evidence run"
        : (args[0]?.split("/").pop()?.replace(/\.ts$/, "") ?? cmd);
    calls.push(echo ? `${label} (echo)` : label);
    const changed = change[label];
    if (changed !== undefined) return changed(args);
    if (label === "evidence run") return ok(PASS);
    if (label === "dry-run") return ok(`${DRY_RUN}\n`);
    if (label === "proof") return ok(PROOF_PASS);
    return ok(`${label}: PASS items=1 failures=0\n`);
  };
  return { exec, calls };
}

/** Each released package has a dist newer than its src. */
const freshStat: Stat = (dir) =>
  dir.endsWith("/dist")
    ? { files: 2, oldest: 2_000, newest: 3_000 }
    : { files: 3, oldest: 500, newest: 1_000 };

const check = (options: Partial<Parameters<typeof releaseCheck>[0]> = {}) =>
  releaseCheck({
    root: ROOT,
    exec: fakeExec().exec,
    stat: freshStat,
    load: () => [1.5, 2.25, 3],
    uptime: () => 2 * 86_400 + 5 * 3600,
    env: {},
    ...options,
  });

describe("release-check", () => {
  it("passes a full run", async () => {
    const run = read(PASS);
    expect(run.failures).toEqual([]);
    expect(run.counts).toMatchObject({
      tasks: 33,
      total: 33,
      cached: 0,
      packages: 5,
      withTest: 5,
    });
    // Each package has its vitest summary or its own PASS lines.
    expect(run.notes).toContain("authtempo-example-node: 2 check lines");
    expect(run.notes).toContain(
      "authtempo-release: Test Files 19 passed (19); Tests 326 passed (326)",
    );
    expect(run.notes).toContain("typecheck:configs checked 57 vitest config files (minimum 57)");
    const conformance = readConformance(PASS, ["@authtempo/adapter-sqlite"]);
    expect(conformance.failures).toEqual([]);
    expect(conformance.counts).toEqual({ suites: 40, packages: 1, reporters: 1 });

    const f = fakeExec();
    const report = await check({ exec: f.exec });
    expect(report.failures).toEqual([]);
    expect(releaseCheckLine(report)).toBe(
      "release-check: PASS tasks=33 of 33 cached=0 packages=5 of 5 checks=10 of 10 dry-run=PASS load=1.50 failures=0",
    );
    expect(report.notes).toContain(
      "check-security-policy: PASS sections=7 rows=0 channels=2 failures=0",
    );
    expect(report.notes).toContain(`@authtempo/breach-check@0.1.0 ${SHA} files=6`);
  });

  it("reads the log of a GitHub runner, and names the cause of a log with no prefix", () => {
    // GitHub Actions sets GITHUB_ACTIONS=true, and Turbo 2.11.7 then drops the
    // prefix of each line unless the run has --log-prefix=task (review Major 2).
    expect(EVIDENCE_RUN).toContain("--log-prefix=task");
    const one = ["@authtempo/breach-check"];
    const github = (text: string) => readTurboRun(text, one, { withTypecheck: one, configs: true });
    const task = github(GITHUB_TASK);
    expect(task.failures).toEqual([]);
    expect(task.counts).toMatchObject({ tasks: 4, total: 4, cached: 0, packages: 1, withTest: 1 });
    expect(task.notes).toContain(
      "@authtempo/breach-check: Test Files 1 passed | 1 skipped (2); Tests 8 passed | 1 skipped (9); 2 check lines",
    );
    expect(github(GITHUB_AUTO).failures).toEqual([
      'the log has 4 ::group:: tasks with no "<package>:<task>: " prefix, such as @authtempo/breach-check:build; Turbo drops the prefix under GITHUB_ACTIONS=true unless it runs with --log-prefix=task',
      "@authtempo/breach-check has a test script and no @authtempo/breach-check:test block; it did not report",
      "@authtempo/breach-check has a typecheck script and no @authtempo/breach-check:typecheck block; it did not report",
      "//:typecheck:configs printed no count line",
    ]);
  });

  it("fails when a package did not report", () => {
    const run = read(withoutBlock("@authtempo/breach-check:test"));
    expect(run.failures).toEqual([
      "@authtempo/breach-check has a test script and no @authtempo/breach-check:test block; it did not report",
    ]);
    expect(run.counts).toMatchObject({ packages: 4, withTest: 5 });
    // The packages come from the workspace, never from a fixed list.
    expect(readTurboRun(PASS, [...WITH_TEST, "@authtempo/core"]).failures).toEqual([
      "@authtempo/core has a test script and no @authtempo/core:test block; it did not report",
    ]);
    expect(read(withoutBlock("@authtempo/site:typecheck")).failures).toEqual([
      "@authtempo/site has a typecheck script and no @authtempo/site:typecheck block; it did not report",
    ]);
  });

  it("fails on a cached task", async () => {
    const cached = change("Cached:    0 cached, 33 total", "Cached:    1 cached, 33 total");
    expect(read(cached).failures).toEqual([
      "the run has 1 cached tasks; a cached task is not evidence",
    ]);
    const f = fakeExec({ "evidence run": () => ok(cached) });
    const report = await check({ exec: f.exec });
    expect(releaseCheckLine(report)).toBe(
      "release-check: FAIL tasks=33 of 33 cached=1 packages=5 of 5 checks=0 of 10 dry-run=not-run load=1.50 failures=1",
    );
  });

  it("reads a failure count from the summary line", () => {
    // One change: the vitest summary of authtempo-release says 1 failed. The log
    // holds no FAIL mark of vitest or of a check, and Turbo still counts 33 successful.
    const failed = change("326 passed", "1 failed | 325 passed");
    expect(stripColours(failed)).not.toMatch(/(^|: )\s*FAIL\s|: FAIL\b/m);
    expect(read(failed).failures).toEqual([
      "authtempo-release:test: Tests 1 failed | 325 passed (326)",
    ]);
    // A check line counts its own failures.
    const check = change(
      "check-security-policy: PASS sections=7 rows=0 channels=2 failures=0",
      "check-security-policy: PASS sections=7 rows=0 channels=2 failures=1",
    );
    expect(read(check).failures).toEqual([
      "@authtempo/site:test: check-security-policy: PASS sections=7 rows=0 channels=2 failures=1",
    ]);
    // The Turbo summary line counts the tasks.
    expect(read(change(" Tasks:    33 successful", " Tasks:    32 successful")).failures).toEqual([
      "Turbo ran 32 of 33 tasks successfully",
    ]);
  });

  it("fails when the build is older than the change", async () => {
    const stale: Stat = (dir) =>
      dir.endsWith("breach-check/dist") ? { files: 2, oldest: 900, newest: 3_000 } : freshStat(dir);
    expect(
      buildFailures([{ name: "@authtempo/breach-check", dir: "/x/packages/breach-check" }], stale),
    ).toEqual([
      "@authtempo/breach-check: dist (oldest 1970-01-01T00:00:00.900Z) is older than src (newest 1970-01-01T00:00:01.000Z); the build is older than the change",
    ]);
    expect(buildFailures([{ name: "@authtempo/x", dir: "/x" }], () => null)).toEqual([
      "@authtempo/x: no file in dist; the build did not run",
    ]);
    const report = await check({ stat: stale });
    expect(report.stopped).toBe("evidence run");
    expect(report.failures).toEqual([
      "@authtempo/breach-check: dist (oldest 1970-01-01T00:00:00.900Z) is older than src (newest 1970-01-01T00:00:01.000Z); the build is older than the change",
    ]);
  });

  it("records the load and the uptime beside the counts", async () => {
    let reads = 0;
    const report = await check({
      load: () => (reads++ === 0 ? [1.5, 2.25, 3] : [12, 8, 4]),
    });
    expect(releaseCheckLine(report)).toMatch(/ load=1\.50 failures=0$/);
    expect(report.notes[0]).toBe("uptime 2 days 5 hours, load 1.50 2.25 3.00 at the start");
    expect(report.notes.at(-1)).toBe("load 12.00 8.00 4.00 at the end");
  });

  it("stops at the first failed step", async () => {
    // The order: the evidence run, the conformance counts, the release checks, the dry run.
    const full = fakeExec();
    await check({ exec: full.exec });
    expect(full.calls).toEqual([
      "evidence run (echo)",
      ...CHECKS.map((c) => c.name),
      "proof",
      "dry-run",
    ]);

    const evidence = fakeExec({ "evidence run": () => ({ status: 1, stdout: PASS, stderr: "" }) });
    const r1 = await check({ exec: evidence.exec });
    expect(r1.stopped).toBe("evidence run");
    expect(r1.failures).toEqual(["the evidence run exited 1, and its log names no failure"]);
    expect(evidence.calls).toEqual(["evidence run (echo)"]);
    expect(r1.notes).toContain("not run: dry run, after the failed evidence run");

    const conformance = fakeExec({
      "evidence run": () =>
        ok(
          change(
            "limiter conformance: better-sqlite3 tests=10 passed=10",
            "limiter conformance: better-sqlite3 tests=10 passed=9",
          ),
        ),
    });
    const r2 = await check({ exec: conformance.exec });
    expect(r2.stopped).toBe("conformance counts");
    expect(r2.failures).toHaveLength(1);
    expect(r2.failures[0]).toBe(
      "@authtempo/adapter-sqlite: the suite limiter conformance: better-sqlite3 passed 9 of 10 tests",
    );
    expect(conformance.calls).toEqual(["evidence run (echo)"]);

    const checks = fakeExec({
      "check-records": () => ({
        status: 1,
        stdout:
          "check-records: FAIL files=1 failures=1\n  docs/security/advisories.md: an entry changed\n",
        stderr: "",
      }),
      "check-workflows": () => ({ status: 1, stdout: "", stderr: "a stack\n" }),
    });
    const r3 = await check({ exec: checks.exec });
    expect(r3.stopped).toBe("release checks");
    expect(r3.failures).toEqual([
      "check-records exited 1: check-records: FAIL files=1 failures=1",
      "check-records: docs/security/advisories.md: an entry changed",
      "check-workflows exited 1 and printed no summary line",
    ]);
    // Each check runs, so the run names each failing check; the dry run does not start.
    expect(checks.calls).toEqual(["evidence run (echo)", ...CHECKS.map((c) => c.name), "proof"]);
    expect(releaseCheckLine(r3)).toMatch(/ checks=8 of 10 dry-run=not-run /);

    const dry = fakeExec({
      "dry-run": () => ({
        status: 1,
        stdout:
          "release-dry-run: FAIL packages=0 of 2 version=0.1.0 tarballs=2 files=46 smoke=0 failures=1\n  check-pack exited 1\n",
        stderr: "",
      }),
    });
    const r4 = await check({ exec: dry.exec });
    expect(r4.stopped).toBe("dry run");
    expect(r4.dryRun).toBe("FAIL");
    expect(r4.failures).toEqual([
      "the dry run exited 1: release-dry-run: FAIL packages=0 of 2 version=0.1.0 tarballs=2 files=46 smoke=0 failures=1",
      "dry run: check-pack exited 1",
    ]);
    // A PASS line needs one SHA-256 line for each released package.
    const oneSha = fakeExec({ "dry-run": () => ok(DRY_RUN.split("\n").slice(1).join("\n")) });
    const r5 = await check({ exec: oneSha.exec });
    expect(r5.failures).toEqual([
      "the dry run printed 0 SHA-256 lines for @authtempo/adapter-sqlite, not 1",
    ]);
  });

  it("prints a skipped check as not run, and refuses another OSV_URL", async () => {
    const f = fakeExec();
    const report = await check({ exec: f.exec, osv: false, dryRun: false });
    expect(report.failures).toEqual([]);
    expect(releaseCheckLine(report)).toBe(
      "release-check: PASS tasks=33 of 33 cached=0 packages=5 of 5 checks=9 of 10 dry-run=not-run load=1.50 failures=0",
    );
    expect(report.notes).toContain("not run: check-osv (--no-osv)");
    expect(report.notes).toContain("not run: dry run (--no-dry-run)");
    expect(f.calls).not.toContain("check-osv");
    expect(f.calls).not.toContain("dry-run");
    // A test server that answers an empty result would make check-osv pass on nothing (ruling 33).
    const other = await check({ env: { OSV_URL: "http://127.0.0.1:9/v1/querybatch" } });
    expect(other.failures).toEqual([
      `check-osv: OSV_URL is http://127.0.0.1:9/v1/querybatch; release-check reads only ${OSV_BATCH_URL}`,
    ]);
    expect((await check({ env: { OSV_URL: OSV_BATCH_URL } })).failures).toEqual([]);
    // --base goes to check-changesets and check-records.
    const based = fakeExec({
      "check-changesets": (args) => ok(`check-changesets: PASS ref=${args[1]} failures=0\n`),
    });
    expect((await check({ exec: based.exec, base: "origin/main" })).notes).toContain(
      "check-changesets: PASS ref=origin/main failures=0",
    );
    expect(parseArgs(["--no-osv", "--no-dry-run", "--base", "origin/main"])).toEqual({
      osv: false,
      dryRun: false,
      base: "origin/main",
    });
    expect(parseArgs([])).toEqual({ osv: true, dryRun: true, base: "main" });
    expect(() => parseArgs(["--base"])).toThrow("unknown argument --base");
    expect(() => parseArgs(["--osv"])).toThrow("unknown argument --osv");
  });

  it("fails a vitest package that passed no test, also when each test skipped (review Minor 1)", () => {
    // Probe C of the review: every test of authtempo-release skipped. The two
    // summary lines of its block are colour coded, so the change reads by line.
    const all = PASS.split("\n")
      .map((l) =>
        l.startsWith("authtempo-release:test: ") && /Test Files|Tests/.test(stripColours(l))
          ? l.replace(/(\d+) passed/, "$1 skipped")
          : l,
      )
      .join("\n");
    expect(stripColours(all)).toContain("authtempo-release:test:       Tests  326 skipped (326)");
    expect(read(all).failures).toEqual([
      "authtempo-release:test: read 0 passed tests: Tests 326 skipped (326)",
    ]);
    expect(read(all).counts.packages).toBe(4);
    // A package that also passes tests keeps its skip as a note (breach-check skips 1).
    expect(read(PASS).failures).toEqual([]);
  });

  it("reads the Turbo summary only outside the task blocks, once (review Minor 2)", () => {
    // Probe D of the review: a task prints a summary of 0 cached before the real one of 1 cached.
    const inner = change(
      "authtempo-release:test: $ vitest run",
      "authtempo-release:test: Cached:    0 cached, 33 total\nauthtempo-release:test:  Tasks:    33 successful, 33 total\nauthtempo-release:test: $ vitest run",
    );
    const real = inner
      .split("\n Tasks:    33 successful, 33 total\nCached:    0 cached, 33 total\n")
      .join("\n Tasks:    32 successful, 33 total\nCached:    1 cached, 33 total\n");
    expect(real).not.toBe(inner);
    expect(read(real).failures).toEqual([
      "Turbo ran 32 of 33 tasks successfully",
      "the run has 1 cached tasks; a cached task is not evidence",
    ]);
    // A second summary outside the blocks fails.
    const twice = change(
      "  Time:    48.338s",
      " Tasks:    33 successful, 33 total\n  Time:    48.338s",
    );
    expect(read(twice).failures).toEqual(["the log has 2 Turbo summary lines of Tasks:, not 1"]);
  });

  it("fails a Failed line and an ERROR line of Turbo (review Minor 3)", () => {
    // The forms of a failed run of Turbo 2.11.7 (a run of 2026-10-30 with --continue).
    expect(
      read(change("  Time:    48.338s", "  Time:    48.338s\nFailed:    authtempo-release#test"))
        .failures,
    ).toEqual(["Turbo failed: authtempo-release#test"]);
    expect(
      read(
        change(
          " Tasks:    33 successful",
          "authtempo-release#test:  ERROR  command (/work/authtempo/scripts/release) /usr/bin/pnpm run test exited (1)\n\n Tasks:    33 successful",
        ),
      ).failures,
    ).toEqual([
      "authtempo-release#test: ERROR command (/work/authtempo/scripts/release) /usr/bin/pnpm run test exited (1)",
    ]);
  });

  it("runs or names each check of src/ (review Minor 4)", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = readdirSync(src)
      .filter((f) => /^check-[\w-]+\.ts$/.test(f))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    const run = CHECKS.map((c) => c.name);
    const exempt = Object.keys(CHECK_EXEMPT);
    expect([...run, ...exempt].sort()).toEqual(files);
    for (const name of exempt) expect(run, name).not.toContain(name);
    expect(exempt.sort()).toEqual(["check-pack", "check-tag"]);
  });

  it("runs each proof test of UNPUBLISHED_CODE by its title (review Low 1)", async () => {
    expect(proofTests()).toEqual([UNPUBLISHED_CODE[0]?.proof]);
    expect(
      proofRun({ file: "packages/cli/test/x.test.ts", title: "runs at 0.1.0 (a: b)" }),
    ).toEqual([
      "node",
      "scripts/test-servers.mjs",
      "run",
      "--",
      "pnpm",
      "--dir",
      "packages/cli",
      "exec",
      "vitest",
      "run",
      "test/x.test.ts",
      "-t",
      "runs at 0\\.1\\.0 \\(a: b\\)",
    ]);
    const report = await check();
    expect(report.notes).toContain(
      `proof ${UNPUBLISHED_CODE[0]?.proof.file}: Tests 1 passed | 11 skipped (12)`,
    );
    // A proof that is gone or skipped reads no passed test, and a failed proof fails.
    const at = `the proof "${UNPUBLISHED_CODE[0]?.proof.title}" of ${UNPUBLISHED_CODE[0]?.proof.file}`;
    const gone = await check({
      exec: fakeExec({
        proof: () => ok(" Test Files  1 skipped (1)\n      Tests  12 skipped (12)\n"),
      }).exec,
    });
    expect(gone.failures).toEqual([`${at} exited 0: Tests 12 skipped (12); it must pass 1 test`]);
    expect(gone.stopped).toBe("release checks");
    const failed = await check({
      exec: fakeExec({
        proof: () => ({
          status: 1,
          stdout: "      Tests  1 failed | 11 skipped (12)\n",
          stderr: "",
        }),
      }).exec,
    });
    expect(failed.failures).toEqual([
      `${at} exited 1: Tests 1 failed | 11 skipped (12); it must pass 1 test`,
    ]);
    const silent = await check({
      exec: fakeExec({ proof: () => ({ status: 1, stdout: "", stderr: "x" }) }).exec,
    });
    expect(silent.failures).toEqual([`${at} exited 1 and printed 0 vitest Tests lines, not 1`]);
  });

  it("matches each SHA-256 line of the dry run to a released name (review Low 2)", async () => {
    const [first = "", , summary = ""] = DRY_RUN.split("\n");
    // Two lines for one package and none for the other: the count alone passed this.
    const doubled = fakeExec({ "dry-run": () => ok(`${first}\n${first}\n${summary}\n`) });
    expect((await check({ exec: doubled.exec })).failures).toEqual([
      "the dry run printed 2 SHA-256 lines for @authtempo/adapter-sqlite, not 1",
      "the dry run printed 0 SHA-256 lines for @authtempo/breach-check, not 1",
    ]);
    const other = fakeExec({
      "dry-run": () => ok(`${DRY_RUN.replace("@authtempo/breach-check@", "@authtempo/other@")}\n`),
    });
    expect((await check({ exec: other.exec })).failures).toEqual([
      "the dry run printed 0 SHA-256 lines for @authtempo/breach-check, not 1",
      "the dry run printed a SHA-256 line for @authtempo/other, which is not released",
    ]);
  });

  it("finds each package of the conformance reporter in the workspace", () => {
    expect(reporterPackages(ROOT)).toEqual(["@authtempo/adapter-sqlite"]);
    // A package of the reporter that reported no suite fails.
    expect(
      readConformance(PASS, ["@authtempo/adapter-sqlite", "@authtempo/site"]).failures,
    ).toEqual(["@authtempo/site runs the conformance reporter and reported no suite"]);
    // The real tree: each package with the reporter in a vitest config.
    const root = join(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(reporterPackages(root)).toEqual(
      expect.arrayContaining(["@authtempo/adapter-d1", "@authtempo/core"]),
    );
  });
});
