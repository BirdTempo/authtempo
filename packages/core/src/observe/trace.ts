/**
 * The trace of a request (plan 12h, spec 31 item 5), by the W3C Trace
 * Context Recommendation of 2021-11-23: version `00`, lowercase hex, and no
 * all-zero id. No id derives from user data (W3C Trace Context, privacy
 * section). A client trace id is off by default: a client could join its
 * requests to another person's trace in the app's backend.
 */

/** The header of every answer of `handle`. It holds the trace id of the request. */
export const TRACE_HEADER = "x-authtempo-trace";

function hex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A new trace id of 16 random bytes and a span id of 8 random bytes, as lowercase hex. */
export function mintTrace(): { traceId: string; spanId: string } {
  return { traceId: hex(16), spanId: hex(8) };
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** The ids of a valid `traceparent` header of version 00, or null for any other value. */
export function parseTraceparent(
  value: string | null,
): { traceId: string; parentSpanId: string } | null {
  if (value === null) return null;
  const m = TRACEPARENT.exec(value);
  const traceId = m?.[1];
  const parentSpanId = m?.[2];
  if (traceId === undefined || parentSpanId === undefined) return null;
  if (traceId === ZERO_TRACE || parentSpanId === ZERO_SPAN) return null;
  return { traceId, parentSpanId };
}
