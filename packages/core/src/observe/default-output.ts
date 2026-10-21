/**
 * The one file of core that calls console (plan 12h). With no sink, these
 * are the log lines of today, word for word (owner decision 1 of 2026-10-14).
 */
import { scrub } from "../redact.js";
import { type EventInput, type EventName, specOf, validateEvent } from "./events.js";
import type { AuthEvent } from "./port.js";

/**
 * Each string argument passes through `scrub` with the secret values of the
 * config: the last guard of spec 31 item 9. The field kinds are the control.
 */
function scrubbed(args: readonly unknown[], secrets: ReadonlySet<string>): unknown[] {
  return args.map((a) => (typeof a === "string" ? scrub(a, secrets) : a));
}

/** Writes the line of a fault event with its own method. Any other event writes nothing. */
export function defaultOutput(event: AuthEvent, secrets: ReadonlySet<string>): void {
  const line = specOf(event.name as EventName).line;
  if (!line) return;
  console[line.method](...scrubbed(line.args(event), secrets));
}

/**
 * Writes the line of a construction entry, with or without a sink: a sink
 * must not run inside `createAuth` (deviation 7 of plan 12h).
 */
export function writeConstructionLine(input: EventInput, secrets: ReadonlySet<string>): void {
  const { fields } = validateEvent(input.name, { ...input });
  // No sink gets this event, and the line reads only its fields: no time and no ids.
  defaultOutput(
    {
      name: input.name,
      level: specOf(input.name).level,
      at: "",
      traceId: "",
      spanId: "",
      ...fields,
    },
    secrets,
  );
}
