import { exitCode, verifyReport } from "@authtempo/import";
import input from "authtempo-import-input";
import { isVerifyInput, runImport, targetOf } from "./run.js";

/** The bindings and vars of worker/wrangler.jsonc. */
export interface ImportEnv {
  DB: D1Database;
  /** "1" only from `--var LOCAL_IMPORT:1` in the documented wrangler dev command. */
  LOCAL_IMPORT?: string;
  /** "core" (the default in wrangler.jsonc) or "compat", from `--var TARGET:compat` (plan 9b2). */
  TARGET?: string;
}

/**
 * The D1 import (plan 9b). No fetch handler, so the Worker serves no route:
 * the operator runs it on their own machine with `wrangler dev
 * --test-scheduled` and starts it with one request to the local
 * `/__scheduled` path, which only wrangler dev serves (worker/README.md).
 * It prints the report, the target, the CLI's exit status, and the verify of
 * a verify bundle (else null) as one JSON line to the wrangler terminal.
 *
 * The module `authtempo-import-input` is the git-ignored
 * input/import.local.json (the `alias` in worker/wrangler.jsonc).
 */
export default {
  async scheduled(_controller: ScheduledController, env: ImportEnv): Promise<void> {
    // A deployed copy gets no LOCAL_IMPORT, so it refuses before it reads the input.
    if (env.LOCAL_IMPORT !== "1")
      throw new Error(
        "authtempo import: the D1 Worker runs only under wrangler dev with --var LOCAL_IMPORT:1 (worker/README.md); nothing was written",
      );
    const target = targetOf(env.TARGET);
    const report = await runImport(env.DB, input, target);
    // A verify bundle answers the verify rule (spec 23 item 7); else the
    // CLI's exit status: 1 when a person must look at the report.
    const verify = isVerifyInput(input) ? verifyReport(report) : null;
    const status = verify?.code ?? exitCode(report);
    console.log(JSON.stringify({ authtempoImport: report, target, status, verify }));
  },
};
