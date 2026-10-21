/**
 * The Workers Logs sink of `@authtempo/observe` (plan 12h, spec 31 item 13).
 * It writes one `console` call with one plain object for each event. Workers
 * Logs keeps the object as JSON with each field indexed, so a query reads the
 * fields and not a text. The level of the event picks the method.
 */
import type { ObserveSink } from "@authtempo/core/observe";
import { secretParts } from "@authtempo/core/redact";
import { scrubEvent } from "./event-scrub.js";

export type WorkersLogsLevel = "info" | "warn" | "error";

export interface WorkersLogsOptions {
  /** The lowest level that the sink writes. Default `info`: every event. */
  minLevel?: WorkersLogsLevel;
  /**
   * Values that no line may hold, such as a secret of the app. Core puts no
   * secret in an event (spec 31 item 8). This list is a second guard for a
   * string field, and the scrub of `@authtempo/core/redact` applies it.
   */
  secrets?: readonly string[];
}

const RANK: Readonly<Record<WorkersLogsLevel, number>> = { info: 0, warn: 1, error: 2 };
const METHOD = { info: "log", warn: "warn", error: "error" } as const;

/** The sink. It refuses an unknown `minLevel` at once, so a typo never writes every event in silence. */
export function workersLogsSink(options: WorkersLogsOptions = {}): ObserveSink {
  const minLevel = options.minLevel ?? "info";
  if (!Object.hasOwn(RANK, minLevel))
    throw new TypeError(`workersLogsSink: minLevel must be info, warn, or error`);
  const min = RANK[minLevel];
  const secrets = new Set((options.secrets ?? []).flatMap((s) => secretParts(s)));
  return {
    write(batch) {
      for (const event of batch) {
        // A level outside the three counts as error, so an event never drops in silence.
        const level: WorkersLogsLevel = Object.hasOwn(RANK, event.level) ? event.level : "error";
        if (RANK[level] < min) continue;
        // One argument, a plain object: a second argument or a JSON text loses the field index.
        console[METHOD[level]](secrets.size > 0 ? scrubEvent(event, secrets) : { ...event });
      }
    },
  };
}
