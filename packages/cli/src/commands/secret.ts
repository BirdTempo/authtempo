import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isOperatorSecret } from "@authtempo/core/operator-secret";
import { ENTROPY_WARN_BITS, entropyBits, SECRET_VERSION_MAX } from "@authtempo/core/secrets";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { SECRET_HELP } from "../help/secret.js";
import type { SecretJson } from "../json.js";
import { type Ctx, printJson } from "../output.js";
import { DEFAULT_TOKEN_ENV } from "../secrets.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  version: { type: "string" },
  out: { type: "string" },
  operator: { type: "boolean" },
} as const;

/** The bytes of one value: 32, as `openssl rand -base64 32` of the runbook gives. */
export const SECRET_BYTES = 32;

/**
 * The chance of one draw under 120 bits is about 10^-36: 43 symbols from 6
 * or fewer of 64. The loop guards against a broken source, and a test proves
 * it with an injected source.
 */
export const MAX_DRAWS = 3;

/** A version is digits only; the range check comes after. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * One value of SECRET_BYTES bytes as base64url with no padding: 43 characters
 * of A-Z, a-z, 0-9, - and _. A draw under ENTROPY_WARN_BITS, by core's own
 * estimate (one source), is drawn again, at most MAX_DRAWS draws in all.
 */
function draw(ctx: Ctx): { value: string; bits: number } {
  for (let n = 0; n < MAX_DRAWS; n++) {
    const value = Buffer.from(ctx.randomBytes(SECRET_BYTES)).toString("base64url");
    const bits = Math.floor(entropyBits(value));
    if (bits >= ENTROPY_WARN_BITS) return { value, bits };
  }
  throw new Stop(
    `the random source gave ${MAX_DRAWS} values under ${ENTROPY_WARN_BITS} bits; nothing was printed`,
  );
}

/** The version of `--version`, or a usage error. */
function versionOf(flag: string | undefined): number | null {
  if (flag === undefined) return null;
  const version = WHOLE_NUMBER.test(flag) ? Number(flag) : Number.NaN;
  if (!(version >= 1 && version <= SECRET_VERSION_MAX))
    throw new UsageError(`--version is a whole number from 1 to ${SECRET_VERSION_MAX}`);
  return version;
}

/**
 * `authtempo secret` (plan 11c2): a new app secret or operator secret from
 * 32 bytes of the Web Crypto source. The value goes to stdout once, or to a
 * new file with mode 0600, never both and never to stderr. After that one
 * write the value joins the scrub list, so no later line can carry it. The
 * subcommands `status` and `rewrap` come with Task 4.
 */
export const secretCommand: Command = {
  help: SECRET_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    // Task 4 adds the subcommands; until then a positional is a usage error.
    if (positionals.length > 0) throw new UsageError(`unexpected argument ${positionals[0]}`);
    const json = values.json === true;
    const operator = values.operator === true;
    const version = versionOf(values.version);
    if (operator && version !== null)
      throw new UsageError("--operator makes an operator secret: do not give --version");
    if (values.out !== undefined && !operator && version === null)
      throw new UsageError(
        "--out needs --version or --operator, so the result names what the file holds",
      );
    const { value, bits } = draw(ctx);
    // Core's own rule of the operator secret (one source): the route refuses any other form.
    if (operator && !isOperatorSecret(value))
      throw new Stop("the value does not have the form of an operator secret; nothing was printed");
    // The hash of the UTF-8 text, as the operator route of core computes it from the presented secret.
    const secretHash = operator ? createHash("sha256").update(value, "utf8").digest("hex") : null;
    let out: string | null = null;
    if (values.out !== undefined) {
      out = resolve(ctx.cwd, values.out);
      ctx.err(`writing ${out}`);
      try {
        ctx.writeNewPrivate(out, `${value}\n`);
      } catch (e) {
        if ((e as { code?: unknown }).code === "EEXIST")
          throw new Stop(
            `${out} exists: the command refuses a path that exists, because a replaced secret locks out each second-factor user`,
          );
        throw new Stop(`cannot write ${out}`);
      }
    }
    const doc: SecretJson = {
      kind: operator ? "operator" : "app",
      value: out === null ? value : null,
      version,
      bytes: SECRET_BYTES,
      estimateBits: bits,
      out,
      secretHash,
      exit: 0,
      stopped: null,
    };
    if (json) printJson(ctx, doc);
    else if (out === null) ctx.out(value);
    if (!json && secretHash !== null) ctx.out(`secretHash: ${secretHash}`);
    ctx.addSecret(value);
    if (out === null) ctx.err("Store this value now. authtempo keeps no copy of it.");
    if (version !== null)
      ctx.err(
        `Next: add { version: ${version}, value } to secrets after the current version, and deploy. Make it the current version in a second deploy.`,
      );
    if (operator)
      ctx.err(
        `Next: set operator.secretHash to this hash, and give the secret to authtempo in ${DEFAULT_TOKEN_ENV}.`,
      );
    return 0;
  },
};
