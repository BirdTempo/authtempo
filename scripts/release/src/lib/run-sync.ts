// The one sync child process call of scripts/release, apart from tar of
// check-pack.ts. A sync spawn blocks the event loop, so the test timeout of
// vitest cannot end it. The limit of the spawn is the one guard against a call
// that never ends (follow-up 1 of plan 12m). This file imports only a Node
// module, because the publish job runs publish.ts with no install.
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";

/**
 * The limit of one git call. Ten git calls of these scripts each took at most
 * 29 ms on this repository, on 2026-11-03 at load 2.6 to 3.7 on 18 cores.
 * Each test of git.test.ts makes several git calls. In the rehearsal logs of
 * 2026-10-31 to 2026-11-03, each such test took at most 662 ms, at load 6.9
 * to 24.1.
 */
export const GIT_TIMEOUT_MS = 60_000;

/**
 * The limit of one npm read, such as npm view, and of changeset status. On
 * 2026-11-03, at load 2.6 to 3.7 on 18 cores, npm view on the public registry
 * took at most 1022 ms. npm --version took at most 139 ms, and changeset
 * status took at most 498 ms.
 */
export const REGISTRY_TIMEOUT_MS = 120_000;

/**
 * The limit of one step of the dry run, such as an install, a build, a pack,
 * or a publish dry run. On 2026-11-03, at load 2.6 to 4.0 on 18 cores, the
 * full dry run took 28.7 s. Its slowest step took 7.7 s: node smoke.mjs of
 * the kits phase. The build took 4.8 s, and the install took 3.1 s. No real
 * npm publish ran before the first release, so publish.ts gives each publish
 * this limit, the widest one.
 */
export const STEP_TIMEOUT_MS = 1_200_000;

/** A call that did not end in its limit. Its message names the call and the limit. */
export class RunTimeout extends Error {}

/** The options of spawnSync, with the limit in place of timeout and killSignal. */
export type RunSyncOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  "encoding" | "killSignal" | "timeout"
> & { timeoutMs: number };

/**
 * Runs `cmd` with `args` and answers the result of spawnSync, with the
 * output as text. A call that does not end in `timeoutMs` throws a
 * RunTimeout with the message `<cmd> <args> did not end in <ms> ms`. Each
 * other result goes to the caller, which reads the status, the output, and
 * the error of the spawn.
 */
export function runSync(cmd: string, args: readonly string[], options: RunSyncOptions) {
  const { timeoutMs, ...rest } = options;
  const r = spawnSync(cmd, args, {
    ...rest,
    encoding: "utf8",
    // A child that ignores SIGTERM, the default signal, must not block a run.
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
    throw new RunTimeout(`${[cmd, ...args].join(" ")} did not end in ${timeoutMs} ms`);
  return r;
}
