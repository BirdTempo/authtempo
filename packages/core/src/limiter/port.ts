/**
 * The separator of the stored key `${key}${SEP}${seconds}${SEP}${max}`:
 * U+001F, the unit separator. A limiter refuses a key that contains it.
 * No caller value can carry it: normalizeEmail refuses control characters
 * and an IP address has none. A key with it would alias another window.
 */
export const KEY_SEPARATOR = "\u001f";

export interface LimitWindow {
  seconds: number;
  max: number;
}

/** Returns true when the call is within the limit. The key names the subject, for example `magic-link:email:a@example.com`. A key called with two different windows is two independent limits. */
export interface LimiterPort {
  allow(key: string, window: LimitWindow): Promise<boolean>;
}
