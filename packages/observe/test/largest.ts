import { type AuthEvent, EVENTS, type EventName, type EventSpec } from "@authtempo/core/observe";
import { FIELD_KINDS, type FieldKind, REJECT } from "@authtempo/core/redact";

/**
 * The longest value that each field kind keeps (spec 31 item 7). A Record, so
 * a new kind fails the compile until it has a row here.
 */
const LONGEST: Readonly<Record<FieldKind, unknown>> = {
  id: "i".repeat(64),
  enum: "e".repeat(128),
  code: "c".repeat(128),
  route: "r".repeat(128),
  routePath: "p".repeat(128),
  name: `n${"a".repeat(31)}`,
  identifier: "f".repeat(64),
  errorName: `${"A".repeat(59)}Error`,
  errorClass: "C".repeat(64),
  count: Number.MAX_SAFE_INTEGER,
  durationMs: Number.MAX_SAFE_INTEGER,
  status: Number.MAX_SAFE_INTEGER,
  hash: "f".repeat(32),
  clientRef: `cl_${"x".repeat(64)}`,
  // The method kind of plan 12h ruling 12: an RFC 9110 token of at most 32 characters.
  method: "M".repeat(32),
};

/**
 * The largest event until the recorder of plan 12h Task 12 gives the largest
 * event of the core suite. It holds every field of every row of `EVENTS` at
 * the longest value of its kind. The address fields have their longest form,
 * and `rejected` holds every field name.
 */
export function largestEvent(): AuthEvent {
  const fields: Record<string, unknown> = {};
  for (const spec of Object.values(EVENTS) as EventSpec[])
    for (const [field, f] of Object.entries(spec.fields)) {
      const value = LONGEST[f.kind];
      // The value must pass its kind unchanged, or the bound here is not the bound of core.
      if (FIELD_KINDS[f.kind](value) !== value || FIELD_KINDS[f.kind](value) === REJECT)
        throw new Error(`the longest ${f.kind} value does not pass its kind`);
      fields[field] = value;
    }
  const name = Object.keys(EVENTS).reduce((a, b) => (b.length > a.length ? b : a)) as EventName;
  return {
    ...fields,
    name,
    level: "error",
    at: "2026-10-21T10:00:00.000Z",
    traceId: "f".repeat(32),
    spanId: "f".repeat(16),
    parentSpanId: "f".repeat(16),
    // The opt-in address fields: a raw IPv6 of 45 characters, the agent cut at 256, two hashes.
    ip: "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255",
    ipHash: "f".repeat(32),
    userAgent: "u".repeat(256),
    emailHash: "f".repeat(32),
    rejected: Object.keys(fields),
  };
}
