import { type AuthEvent, EVENTS, type EventName, validateEvent } from "@authtempo/core/observe";

/**
 * An event as the observer passes it to a sink, built by hand. A name of
 * `EVENTS` passes its fields through the validator of core first, and a
 * rejected field stops the test: a fixture never holds a state that core
 * cannot reach. A name that a later task of plan 12h adds (request, sign_in)
 * has no row yet, so its fields are the ones of spec 31.
 */
export function built(
  name: string,
  level: AuthEvent["level"],
  fields: Record<string, unknown> = {},
): AuthEvent {
  if (Object.hasOwn(EVENTS, name)) {
    const known = name as EventName;
    const { rejected } = validateEvent(known, fields);
    if (rejected.length > 0) throw new Error(`${name} rejects ${rejected.join(", ")}`);
    if (EVENTS[known].level !== level)
      throw new Error(`${name} has the level ${EVENTS[known].level}`);
  }
  return {
    name: name as EventName,
    level,
    at: "2026-10-21T10:00:00.000Z",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    ...fields,
  };
}
