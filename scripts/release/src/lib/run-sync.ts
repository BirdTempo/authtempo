// The one sync child process call of scripts/release, apart from tar of
// check-pack.ts. A sync spawn blocks the event loop, so the test timeout of
// vitest cannot end it. The limit of the spawn is the first guard against a
// call that never ends (follow-up 1 of plan 12m). The timeout-minutes of each
// job in ci.yml and release.yml is the second guard of a hung step. This file
// imports only a Node module, because the publish job runs publish.ts with no
// install.
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";

/**
 * The limit of one git call. Ten git calls of these scripts each took at most
 * 29 ms on this repository on 2026-11-03, on one host with 18 cores. The
 * 1-minute load was 2.69 at the start and 2.64 at the end (log:
 * .superpowers/tools/logs/measure-12n-t1-2026-11-03.log). Each test of
 * git.test.ts makes several git calls. In the six rehearsal logs of 2026-10-31
 * to 2026-11-03 (.superpowers/tools/logs/rehearse-*.log), each such test took
 * at most 662 ms. There the 1-minute load was 6.93 to 12.75 at the start of
 * release-check and 12.92 to 16.83 at its end.
 */
export const GIT_TIMEOUT_MS = 60_000;

/**
 * The limit of one npm read, such as npm view, and of changeset status. On
 * 2026-11-03, on one host with 18 cores, npm view on the public registry took
 * at most 1022 ms. npm --version took at most 139 ms, and changeset status
 * took at most 498 ms. The 1-minute load was 2.69 at the start and 2.64 at the
 * end (log: .superpowers/tools/logs/measure-12n-t1-2026-11-03.log).
 */
export const REGISTRY_TIMEOUT_MS = 120_000;

/**
 * The limit of one step of the dry run, such as an install, a build, a pack,
 * or a publish dry run. On 2026-11-03, on one host with 18 cores, the full dry
 * run took 29.5 s. The 1-minute load was 5.54 at the start and 7.73 at the end
 * (log: .superpowers/tools/logs/dry-run-12n-fix1-2026-11-03.log). Its slowest
 * step took 8.4 s: node smoke.mjs of the kits phase, up to the end of the run.
 * The build took 5.0 s, and the install took 2.1 s. publish.ts gives each npm
 * publish this limit, the widest one. A real npm publish has no measure yet.
 * The first real publish gives it.
 */
export const STEP_TIMEOUT_MS = 1_200_000;

/** The kind of a call. Each kind has its own limit. */
export type LimitKind = "git" | "registry" | "step";

/** The limit of each kind, in ms. runSync reads it at each call. */
const limits: Record<LimitKind, number> = {
  git: GIT_TIMEOUT_MS,
  registry: REGISTRY_TIMEOUT_MS,
  step: STEP_TIMEOUT_MS,
};

/** The limit of `kind` that runSync gives a call now, in ms. */
export const limitOf = (kind: LimitKind): number => limits[kind];

/**
 * Sets the limit of `kind`, and returns the function that restores it. Only a
 * test calls it, and run-sync.test.ts holds that no file of src does. A real
 * limit is one minute or more, so a test of a stall at that limit waits that
 * long. With this setter, a test reaches each catch of a RunTimeout in a few
 * hundred ms (review of Task 1 of plan 12n, L1).
 */
export function setLimitForTest(kind: LimitKind, ms: number): () => void {
  const before = limits[kind];
  limits[kind] = ms;
  return () => {
    limits[kind] = before;
  };
}

/**
 * A call that did not end in its limit. Its message names the call and the
 * limit. stdout and stderr hold the output of the call up to the kill.
 */
export class RunTimeout extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, output: { stdout: string; stderr: string }) {
    super(message);
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }
}

/** The options of spawnSync, with the kind of the call in place of timeout and killSignal. */
export type RunSyncOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  "encoding" | "killSignal" | "timeout"
> & { limit: LimitKind };

/**
 * Runs `cmd` with `args` and answers the result of spawnSync, with the
 * output as text. A call past the limit of its kind throws a RunTimeout with
 * the message `<cmd> <args> did not end in <ms> ms`. Each
 * other result goes to the caller, which reads the status, the output, and
 * the error of the spawn.
 */
export function runSync(cmd: string, args: readonly string[], options: RunSyncOptions) {
  const { limit, ...rest } = options;
  const timeoutMs = limitOf(limit);
  const r = spawnSync(cmd, args, {
    ...rest,
    encoding: "utf8",
    // A child that ignores SIGTERM, the default signal, must not block a run.
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
    throw new RunTimeout(`${[cmd, ...args].join(" ")} did not end in ${timeoutMs} ms`, {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    });
  return r;
}
