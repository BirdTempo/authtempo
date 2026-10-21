/**
 * The last guard of spec 31 item 9 for each sink of `@authtempo/observe`.
 * Core puts no secret in an event (spec 31 item 8). A sink still passes each
 * string field through the scrub of `@authtempo/core/redact` with the secret
 * values that the app gives it.
 */
import type { AuthEvent } from "@authtempo/core/observe";
import { scrub } from "@authtempo/core/redact";

/**
 * The fields that core checks by kind: a name of `EVENTS`, a level, a time,
 * and hex ids. They hold no free text, so no secret. A scrub there breaks
 * the event: a header value `limit` turned the name `limit.hit` into `***.hit`.
 */
const KIND_CHECKED: ReadonlySet<string> = new Set([
  "name",
  "level",
  "at",
  "traceId",
  "spanId",
  "parentSpanId",
]);

/** A string field with each secret replaced by ***. An array of strings, such as `rejected`, too. */
export function scrubEvent(event: AuthEvent, secrets: ReadonlySet<string>): AuthEvent {
  const out: AuthEvent = { ...event };
  for (const [key, value] of Object.entries(out)) {
    if (KIND_CHECKED.has(key)) continue;
    if (typeof value === "string") out[key] = scrub(value, secrets);
    else if (Array.isArray(value))
      out[key] = value.map((v: unknown) => (typeof v === "string" ? scrub(v, secrets) : v));
  }
  return out;
}
