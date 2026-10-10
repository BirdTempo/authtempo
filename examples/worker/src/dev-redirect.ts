/**
 * Reads DEV_REDIRECT_PATTERN. The source must start with `^` and end with `$`. An unanchored
 * pattern admits a redirect that only contains the dev URL, for example
 * `exp://evil/?x=exp://192.168.1.20:8081/--/auth`, and the code then goes to another host.
 * A refused source logs one line and sets no pattern, so the handoff admits only its schemes.
 * The check covers the two ends only. A source such as `^a|b$` passes it, so keep the
 * alternatives inside one group: `^(a|b)$`.
 */
export function devRedirectPattern(
  source: string | undefined,
  log: (line: string) => void = console.warn,
): RegExp | undefined {
  if (!source) return undefined;
  if (!source.startsWith("^") || !source.endsWith("$")) {
    log(
      "DEV_REDIRECT_PATTERN refused: the source must start with ^ and end with $; no dev pattern is set",
    );
    return undefined;
  }
  return new RegExp(source);
}
