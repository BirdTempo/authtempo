/**
 * The last guard of spec 31 item 9 for each sink of `@authtempo/observe`.
 * Core puts no secret in an event (spec 31 item 8). A sink still passes each
 * string field through the scrub of `@authtempo/core/redact` with the secret
 * values that the app gives it.
 */
import { type AuthEvent, EVENTS, type EventSpec, STAMP_FIELDS } from "@authtempo/core/observe";
import { scrub } from "@authtempo/core/redact";

/**
 * The stamp of core: a name of `EVENTS`, a level, a time, hex ids, and the
 * route key. Core checks each one, and its own scrub skips them. A scrub
 * there breaks the event: a header value `limit` turned `limit.hit` into `***.hit`.
 */
const STAMP: ReadonlySet<string> = new Set(STAMP_FIELDS);

/**
 * The field kinds whose value `validateEvent` holds to a closed list of core.
 * Such a value holds no secret. A scrub there splits the metric streams: a
 * header value `oauth` put `***` in place of `oauth` in the route `POST /oauth/token`.
 */
const CLOSED_KINDS: ReadonlySet<string> = new Set(["enum", "code", "route", "routePath"]);

/** For each event of `EVENTS`, the fields of a closed kind, read from its row. */
const CLOSED: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(EVENTS as Readonly<Record<string, EventSpec>>).map(([name, spec]) => [
    name,
    new Set(
      Object.entries(spec.fields)
        .filter(([, field]) => CLOSED_KINDS.has(field.kind))
        .map(([key]) => key),
    ),
  ]),
);

/** A string field with each secret replaced by ***. An array of strings, such as `rejected`, too. */
export function scrubEvent(event: AuthEvent, secrets: ReadonlySet<string>): AuthEvent {
  const out: AuthEvent = { ...event };
  const closed = CLOSED.get(event.name);
  for (const [key, value] of Object.entries(out)) {
    if (STAMP.has(key) || closed?.has(key)) continue;
    if (typeof value === "string") out[key] = scrub(value, secrets);
    else if (Array.isArray(value))
      out[key] = value.map((v: unknown) => (typeof v === "string" ? scrub(v, secrets) : v));
  }
  return out;
}
