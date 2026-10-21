/**
 * The measure entry of plan 12h Task 15. Never deploy it: its mail port writes
 * each mail, with its link, to the log. `pnpm --filter @authtempo/site run
 * measure:performance` starts it with `wrangler dev --local` and this
 * wrangler.jsonc. It is the Worker of src/index.ts with two changes: the
 * password config at the default PBKDF2 iterations, and a sink that also
 * writes each request event as one JSON line.
 */
import type { AuthEvent, MailPort, ObserveSink } from "@authtempo/core";
import { workersLogsSink } from "@authtempo/observe/workers-logs";
import { createWorker } from "./index";
import { measureLine } from "./measure-line";

/** The outbox: one log line for each mail. The script reads the verify links from it. */
const outbox: MailPort = {
  async send(m) {
    console.log(measureLine({ kind: "mail", to: m.to, text: m.text }));
  },
};

/**
 * The sink of src/index.ts, and one line for each request event. Under
 * `wrangler dev` the Workers Logs sink prints an object over many lines, so
 * the script reads this line and not that object.
 */
function measureSink(secret: string): ObserveSink {
  const logs = workersLogsSink({ secrets: [secret] });
  return {
    write(batch: readonly AuthEvent[]) {
      logs.write(batch);
      for (const e of batch) {
        if (e.name !== "request") continue;
        const { traceId, route, status, durationMs } = e;
        if (typeof route !== "string" || typeof status !== "number") continue;
        if (typeof durationMs !== "number") continue;
        console.log(measureLine({ kind: "request", traceId, route, status, durationMs }));
      }
    },
  };
}

export default createWorker(outbox, undefined, (env) => ({
  password: {},
  observe: { sink: measureSink(env.AUTH_SECRET) },
}));
