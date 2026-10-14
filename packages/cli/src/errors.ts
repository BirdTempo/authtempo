/**
 * The two ways a command ends early (spec 19). main prints a UsageError with
 * the short help of the command, and a Stop as one `stopped:` line; both
 * exit 2. This file imports nothing, so src/checks.ts can run in workerd.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class Stop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stop";
  }
}
