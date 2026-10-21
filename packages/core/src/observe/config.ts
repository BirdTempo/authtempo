import { ConfigError } from "../config.js";
import type { ObserveConfig, ObserveSink } from "./port.js";

/** The observe config after its checks, with each default applied. */
export interface ResolvedObserve {
  sink: ObserveSink;
  include: { ip: "none" | "hash" | "raw"; userAgent: "none" | "raw"; email: "none" | "hash" };
  trustTraceparent: boolean;
  buffer: number;
  flushTimeoutMs: number;
  readiness: boolean;
}

const INCLUDE_VALUES = {
  ip: ["none", "hash", "raw"],
  userAgent: ["none", "raw"],
  email: ["none", "hash"],
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, path: string, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new ConfigError(`${path} must be an integer from ${min} to ${max}`);
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be true or false`);
  return value;
}

/**
 * The checks of spec 31 item 1, one `ConfigError` for each refusal. Null
 * when the app gives no `observe`: core then writes the log lines of today
 * and sends nothing anywhere.
 */
export function resolveObserve(input: ObserveConfig | undefined): ResolvedObserve | null {
  if (input === undefined) return null;
  if (!isPlainObject(input)) throw new ConfigError("observe must be an object");
  const sink: unknown = input.sink;
  if (typeof sink !== "object" || sink === null || typeof Reflect.get(sink, "write") !== "function")
    throw new ConfigError("observe.sink must have a write function");
  const include: ResolvedObserve["include"] = { ip: "none", userAgent: "none", email: "none" };
  if (input.include !== undefined) {
    if (!isPlainObject(input.include)) throw new ConfigError("observe.include must be an object");
    for (const [key, value] of Object.entries(input.include)) {
      if (!Object.hasOwn(INCLUDE_VALUES, key))
        throw new ConfigError(`observe.include.${key} is not a key: use ip, userAgent, or email`);
      if (value === undefined) continue;
      if (key === "email" && value !== "none" && value !== "hash")
        throw new ConfigError(
          "observe.include.email is none or hash: a raw email is never written",
        );
      const allowed: readonly string[] = INCLUDE_VALUES[key as keyof typeof INCLUDE_VALUES];
      if (typeof value !== "string" || !allowed.includes(value))
        throw new ConfigError(`observe.include.${key} must be one of: ${allowed.join(", ")}`);
      Object.assign(include, { [key]: value });
    }
  }
  return {
    sink: sink as ObserveSink,
    include,
    trustTraceparent: flag(input.trustTraceparent, "observe.trustTraceparent"),
    buffer: integerIn(input.buffer, "observe.buffer", 10, 10_000, 1000),
    flushTimeoutMs: integerIn(input.flushTimeoutMs, "observe.flushTimeoutMs", 100, 10_000, 2000),
    readiness: flag(input.readiness, "observe.readiness"),
  };
}
