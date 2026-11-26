import { ConfigError } from "../config.js";
import { LIMIT_FAMILIES, type LimitFamily } from "./limit.js";
import type { LimitOverride, ResolvedLimitsConfig } from "./limit-window.js";

export type { LimitOverride, ResolvedLimitsConfig } from "./limit-window.js";

/**
 * The limits of a deployment (an integrator report of 2026-11-25). Core has
 * a fixed window for each limit family, and the limits page lists each one.
 * This block changes a window, and it decides what a request with no client
 * IP does. Off when absent: each family keeps its window, and each request
 * with no client IP shares one count.
 */
export interface LimitsConfig {
  /**
   * What core does with a request that has no client IP: `clientIp` gave
   * `null` for it.
   *
   * - `shared` (default): each per-IP limit counts it on the one key
   *   `unknown`. So one caller with no IP can spend the count of each other
   *   caller with no IP.
   * - `refuse`: `handle` answers 403 `client_ip_missing` before any route,
   *   and no count is shared. An in-process call of `auth.api` with
   *   `ip: null` throws at its first per-IP limit. Use it when a proxy of
   *   yours always sets the client IP, so a request with none did not come
   *   through that proxy.
   */
  noClientIp?: "shared" | "refuse";
  /**
   * The window of a limit family, in place of the window of the limits page.
   * The key is a family, such as `otp:email`. `max` is the count of calls,
   * and `seconds` is the length of the window. Leave `seconds` out to keep
   * the default length.
   *
   * WARNING: A higher `max` or a shorter window lets a caller try more. The
   * defaults are the reviewed numbers. The limiter stores a count under the
   * key and its window, so a change of a window starts a new count.
   *
   * Six families take their window from another setting, and this block
   * refuses them: `LIMITS_FROM_SETTINGS` lists them.
   */
  windows?: Partial<Record<LimitFamily, LimitOverride>>;
}

/** The bounds of a window of `limits.windows`: those of a token window (engine/token-use.ts). */
export const LIMIT_OVERRIDE_SECONDS_MAX = 86_400;
export const LIMIT_OVERRIDE_CALLS_MAX = 100_000;

/**
 * The families whose window comes from another setting, with that setting.
 * `limits.windows` refuses each one: two settings for one number would
 * differ with no message. The site check `check-limits` holds this list to
 * the `limit` calls of core: a family is here exactly when the scan reads no
 * number for a part of its window.
 */
export const LIMITS_FROM_SETTINGS: Readonly<Partial<Record<LimitFamily, string>>> = Object.freeze({
  "token-use:tk": "the rateLimit of the token",
  "token-use:to": "the rateLimit of the token",
  "oauth-device-poll:code": "the poll interval of the device code",
  "phone-otp:all-day": "phone.dailyCap",
  "anonymous:all-day": "anonymous.dailyCap",
  "passkey-sign-up:all-day": "passkey.signUp.dailyCap",
});

const LIMITS_KEYS: Readonly<Record<keyof LimitsConfig, true>> = { noClientIp: true, windows: true };
const OVERRIDE_KEYS: Readonly<Record<keyof LimitOverride, true>> = { max: true, seconds: true };

const whole = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** The limits block of the config, checked. Each fault is a `ConfigError` at the start, never at a request. */
export function resolveLimitsConfig(input: LimitsConfig | undefined): ResolvedLimitsConfig {
  const windows = new Map<LimitFamily, LimitOverride>();
  if (input === undefined) return { noClientIp: "shared", windows };
  if (!isPlain(input)) throw new ConfigError("limits must be an object");
  for (const key of Object.keys(input))
    if (!Object.hasOwn(LIMITS_KEYS, key))
      throw new ConfigError(
        `limits.${key} is not a setting; the settings are noClientIp and windows`,
      );
  const noClientIp = input.noClientIp ?? "shared";
  if (noClientIp !== "shared" && noClientIp !== "refuse")
    throw new ConfigError('limits.noClientIp must be "shared" or "refuse"');
  if (input.windows !== undefined) {
    if (!isPlain(input.windows)) throw new ConfigError("limits.windows must be an object");
    const families: readonly string[] = LIMIT_FAMILIES;
    for (const [family, value] of Object.entries(input.windows as Record<string, unknown>)) {
      const at = `limits.windows["${family}"]`;
      if (!families.includes(family))
        throw new ConfigError(`${at} names no limit family; the limits page lists each family`);
      const setting = LIMITS_FROM_SETTINGS[family as LimitFamily];
      if (setting !== undefined)
        throw new ConfigError(`${at} takes its window from ${setting}; change that setting`);
      if (!isPlain(value)) throw new ConfigError(`${at} must be an object with max`);
      for (const key of Object.keys(value))
        if (!Object.hasOwn(OVERRIDE_KEYS, key))
          throw new ConfigError(`${at}.${key} is not a setting; the settings are max and seconds`);
      if (!whole(value.max, LIMIT_OVERRIDE_CALLS_MAX))
        throw new ConfigError(
          `${at}.max must be a whole number from 1 to ${LIMIT_OVERRIDE_CALLS_MAX}`,
        );
      if (value.seconds !== undefined && !whole(value.seconds, LIMIT_OVERRIDE_SECONDS_MAX))
        throw new ConfigError(
          `${at}.seconds must be a whole number from 1 to ${LIMIT_OVERRIDE_SECONDS_MAX}`,
        );
      windows.set(family as LimitFamily, {
        max: value.max,
        ...(value.seconds === undefined ? {} : { seconds: value.seconds }),
      });
    }
  }
  return { noClientIp, windows };
}
