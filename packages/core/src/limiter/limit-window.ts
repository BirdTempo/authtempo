import type { LimitFamily } from "./limit.js";
import type { LimitWindow } from "./port.js";

/**
 * The resolved form of `limits`, and the window lookup of the `limit` call.
 * This file imports types only. `limit.ts` reads it at each call, and many
 * modules load `limit.ts` first. The check of the block is in
 * limits-config.ts, which imports the config module. With both in one file,
 * the load of `limit.ts` reached the config module before `LIMIT_FAMILIES`
 * had its value, and the site build threw.
 */

/** The window of one family in `limits.windows`. */
export interface LimitOverride {
  /** Whole calls, from 1 to 100000. */
  max: number;
  /** Whole seconds, from 1 to 86400. Default: the length of the family's own window. */
  seconds?: number;
}

export interface ResolvedLimitsConfig {
  noClientIp: "shared" | "refuse";
  windows: ReadonlyMap<LimitFamily, LimitOverride>;
}

/** The window that a `limit` call of `family` counts on: the override of the config, else `window`. */
export function windowFor(
  limits: ResolvedLimitsConfig,
  family: LimitFamily,
  window: LimitWindow,
): LimitWindow {
  const override = limits.windows.get(family);
  if (override === undefined) return window;
  return { seconds: override.seconds ?? window.seconds, max: override.max };
}
