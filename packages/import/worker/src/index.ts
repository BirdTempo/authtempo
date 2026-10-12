import { exitCode } from "@tempo-auth/import";
import input from "tempo-auth-import-input";
import { runImport, targetOf } from "./run.js";

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
 * It prints the report, the target, and the CLI's exit status as one JSON line to the
 * wrangler terminal.
 *
 * The module `tempo-auth-import-input` is the git-ignored
 * input/import.local.json (the `alias` in worker/wrangler.jsonc).
 */
export default {
  async scheduled(_controller: ScheduledController, env: ImportEnv): Promise<void> {
    // A deployed copy gets no LOCAL_IMPORT, so it refuses before it reads the input.
    if (env.LOCAL_IMPORT !== "1")
      throw new Error(
        "tempo-auth import: the D1 Worker runs only under wrangler dev with --var LOCAL_IMPORT:1 (worker/README.md); nothing was written",
      );
    const target = targetOf(env.TARGET);
    const report = await runImport(env.DB, input, target);
    // The CLI's exit status: 1 when a person must look at the report.
    console.log(JSON.stringify({ tempoAuthImport: report, target, status: exitCode(report) }));
  },
};
