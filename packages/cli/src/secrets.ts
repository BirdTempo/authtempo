import { resolve } from "node:path";
import { UsageError } from "./errors.js";
import type { Ctx } from "./output.js";

/** The name of an environment variable: a person who types a URL or a token here gets a usage error. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The longest variable name that a message prints (review of plan 11c, m12). A secret is longer. */
const MAX_SHOWN_NAME = 40;

export interface SecretFlags {
  /** The flag names, such as url-env and url-file, for the messages. */
  envFlag: string;
  fileFlag: string;
  env: string | undefined;
  file: string | undefined;
  /** The variable that the command reads when neither flag is given. */
  defaultEnv: string;
  /** What the value is, for the messages: "the connection string". */
  what: string;
}

/**
 * Reads a secret by the no-secret rule (spec 19, owner decision 2): the name
 * of an environment variable, or a file path (`-` is stdin). No flag takes
 * the value itself. The value goes into the scrub list of `ctx` before this
 * returns, so no output line can carry it.
 */
export function readSecret(ctx: Ctx, f: SecretFlags): string {
  if (f.env !== undefined && f.file !== undefined)
    throw new UsageError(`give --${f.envFlag} or --${f.fileFlag}, not both`);
  let value: string;
  if (f.file !== undefined) {
    let text: string;
    try {
      text = f.file === "-" ? ctx.readStdin() : ctx.readFile(resolve(ctx.cwd, f.file));
    } catch {
      throw new UsageError(`--${f.fileFlag}: cannot read ${f.file}`);
    }
    // A file made with echo ends with a newline, which is not part of the value.
    value = text.replace(/\r?\n$/, "");
    if (value.length === 0) throw new UsageError(`--${f.fileFlag}: ${f.file} is empty`);
  } else {
    const name = f.env ?? f.defaultEnv;
    if (!ENV_NAME.test(name))
      throw new UsageError(`--${f.envFlag} takes the name of a variable, not a value`);
    const v = ctx.env[name];
    if (v === undefined || v.length === 0)
      // A long name can be a hex secret typed in the place of a name, so it is not printed.
      throw new UsageError(
        `set ${name.length <= MAX_SHOWN_NAME ? name : `the variable that --${f.envFlag} names`} to ${f.what}, or give --${f.envFlag} or --${f.fileFlag}`,
      );
    value = v;
  }
  ctx.addSecret(value);
  return value;
}
