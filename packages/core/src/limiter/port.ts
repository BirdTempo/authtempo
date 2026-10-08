export interface LimitWindow {
  seconds: number;
  max: number;
}

/** Returns true when the call is within the limit. The key names the subject, for example `magic-link:email:a@example.com`. A key called with two different windows is two independent limits. */
export interface LimiterPort {
  allow(key: string, window: LimitWindow): Promise<boolean>;
}
