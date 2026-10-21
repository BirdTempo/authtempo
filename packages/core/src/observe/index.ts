/**
 * The `@authtempo/core/observe` entry (plan 12h): the port of the sinks, the
 * event table, the trace header, and the sign-in routes (plan deviation 14).
 * It imports no Node.js module.
 */

export { LIMIT_FAMILIES, type LimitFamily } from "../limiter/limit.js";
export type { EventInput, EventSpec, FaultLine, FieldSpec } from "./events.js";
export { EVENTS, SIGN_IN_ROUTES, validateEvent } from "./events.js";
export type {
  AuthEvent,
  EventName,
  HandleOptions,
  ObserveConfig,
  ObserveSink,
  ObserveStats,
} from "./port.js";
export { STAMP_FIELDS } from "./port.js";
export { TRACE_HEADER } from "./trace.js";
