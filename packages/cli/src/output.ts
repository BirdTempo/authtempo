import { CONTROL, scrub, secretParts } from "@authtempo/core/redact";
import type { Io } from "./io.js";

// The CLI test of the scrub (test/secrets.test.ts) imports these two from here.
export { scrub, secretParts };

/** The io of a command: every line passes the scrub, and a command adds each secret it reads. */
export interface Ctx extends Io {
  addSecret(value: string): void;
}

/** A line as the terminal gets it: the scrub, then each control character as `?`. */
const clean = (line: string, secrets: ReadonlySet<string>) =>
  scrub(line, secrets).replace(CONTROL, "?");

/**
 * The no-secret rule at the last line of defence (spec 19): no output line
 * holds a secret that a command read, and no line holds a control character.
 */
export function guarded(io: Io): Ctx {
  const secrets = new Set<string>();
  return {
    ...io,
    out: (line) => io.out(clean(line, secrets)),
    err: (line) => io.err(clean(line, secrets)),
    addSecret(value) {
      for (const p of secretParts(value)) {
        secrets.add(p);
        // A --json line holds the JSON form of a string. A " or a \ of the
        // secret is escaped there, so the scrub also needs that form.
        const escaped = JSON.stringify(p).slice(1, -1);
        if (escaped !== p) secrets.add(escaped);
      }
    },
  };
}

/** A human line of the result: stdout, or stderr when the command prints JSON. */
export function sayer(ctx: Ctx, json: boolean): (line: string) => void {
  return json ? (line) => ctx.err(line) : (line) => ctx.out(line);
}

/** The one JSON document of `--json`, on one line of stdout. */
export function printJson(ctx: Ctx, doc: unknown): void {
  ctx.out(JSON.stringify(doc));
}

/** A connection string as a person may see it: the host, the port, and the database, never the user or the password. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return "the database";
  }
}
