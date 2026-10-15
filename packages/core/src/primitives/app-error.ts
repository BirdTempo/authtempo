const ERROR_CLASS_RE = /^[A-Za-z]+Error$/;

/**
 * The name of an error from app code, safe for a log line. The app sets the
 * name, so it is app data and can hold a token or a row (plan 9c). Only a
 * plain class name such as `TypeError` passes; anything else logs as
 * `Error`, and a thrown value that is no Error logs as its `typeof`.
 */
export function appErrorName(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  // App code can define a `name` getter that throws. The read must not
  // escape the caller's catch, so a throw here logs as `Error`.
  try {
    const name: unknown = e.name;
    return typeof name === "string" && ERROR_CLASS_RE.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}
