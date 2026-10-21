/** The `@authtempo/core/observe` entry (plan 12h): the port of the sinks and the event table. It imports no Node.js module. */

export { LIMIT_FAMILIES, type LimitFamily } from "../limiter/limit.js";
export type { EventInput, EventSpec, FaultLine, FieldSpec } from "./events.js";
export { EVENTS, validateEvent } from "./events.js";
export type {
  AuthEvent,
  EventName,
  HandleOptions,
  ObserveConfig,
  ObserveSink,
  ObserveStats,
} from "./port.js";
