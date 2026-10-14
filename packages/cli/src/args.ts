import { UsageError } from "./errors.js";

/** The flags of every command (spec 19): the help, and one JSON document on stdout. */
export const COMMON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
} as const;

/** True when `a` and `b` are one edit apart: one character added, removed, or changed. */
export function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** The first known word one edit from `word`, for "Did you mean". */
export function nearest(word: string, known: readonly string[]): string | null {
  return known.find((k) => oneEdit(word, k)) ?? null;
}

/**
 * Runs node:util.parseArgs and turns its errors into usage errors. An
 * unknown flag one edit from a known one gets "Did you mean", and the
 * command does not run (spec 19, the help rule).
 */
export function parseOrUsage<T>(parse: () => T, known: readonly string[]): T {
  try {
    return parse();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if ((e as { code?: unknown }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      // node:util names the flag first, in quotes: "Unknown option '--yess'. …"
      const flag = /'(-{1,2}[^'\s]+)'/.exec(message)?.[1] ?? "";
      const near = flag.startsWith("--") ? nearest(flag.slice(2), known) : null;
      throw new UsageError(
        near ? `unknown flag ${flag}. Did you mean --${near}?` : `unknown flag ${flag}`,
      );
    }
    throw new UsageError(message);
  }
}

/** The value of a flag that takes a closed set, or a usage error that lists the set. */
export function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  const near = nearest(value, allowed);
  throw new UsageError(
    `--${flag} is one of ${allowed.join(", ")}${near ? `. Did you mean ${near}?` : ""}`,
  );
}
