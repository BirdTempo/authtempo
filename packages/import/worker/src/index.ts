import input from "../input/import.json";
import { type D1Bundle, runImport } from "./run.js";

/**
 * The D1 import (plan 9b). No fetch handler, so the Worker serves no route:
 * the operator runs it on their own machine with `wrangler dev
 * --test-scheduled` and starts it with one request to the local
 * `/__scheduled` path, which only wrangler dev serves (worker/README.md).
 * It prints the report as one JSON line to the wrangler terminal.
 */
export default {
  async scheduled(_controller: ScheduledController, env: { DB: D1Database }): Promise<void> {
    const report = await runImport(env.DB, input as unknown as D1Bundle);
    console.log(JSON.stringify({ tempoAuthImport: report }));
  },
};
