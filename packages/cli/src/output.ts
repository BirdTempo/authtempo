import type { Io } from "./io.js";

/**
 * The text of a secret, and the parts that a driver can print alone: the
 * password of a URL, its decoded form, and the user and password pair. A part
 * under 4 characters is dropped: a scrub of one letter mangles every line.
 */
export function secretParts(value: string): string[] {
  const parts = [value];
  try {
    const u = new URL(value);
    if (u.password)
      parts.push(u.password, decodeURIComponent(u.password), `${u.username}:${u.password}`);
  } catch {
    // Not a URL: the value alone.
  }
  return [...new Set(parts)].filter((p) => p.length >= 4);
}

/** Replaces each secret in a line with ***, the longest first. */
export function scrub(text: string, secrets: ReadonlySet<string>): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out;
}

/** The io of a command: every line passes the scrub, and a command adds each secret it reads. */
export interface Ctx extends Io {
  addSecret(value: string): void;
}

/**
 * Each C0 control character but tab, and DEL. Text from a server, a driver,
 * or wrangler can hold an escape sequence that moves the cursor or clears
 * the terminal (spec 19: the CLI writes no escape sequence).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the filter matches control characters on purpose.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

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
