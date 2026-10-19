import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isOperatorSecret } from "@authtempo/core/operator-secret";
import {
  ENTROPY_WARN_BITS,
  entropyBits,
  REWRAP_LIMIT,
  SECRET_VERSION_MAX,
} from "@authtempo/core/secrets";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { SECRET_HELP, SECRET_REWRAP_HELP, SECRET_STATUS_HELP } from "../help/secret.js";
import type { SecretJson, SecretRewrapJson, SecretStatusJson } from "../json.js";
import { baseOf, basePathOf, timeoutOf } from "../net.js";
import { type OperatorValues, operatorCall, readOperatorSecret } from "../operator-client.js";
import { type Ctx, printJson } from "../output.js";
import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "../rewrap-limits.js";
import { DEFAULT_TOKEN_ENV } from "../secrets.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  version: { type: "string" },
  out: { type: "string" },
  operator: { type: "boolean" },
} as const;

/** The flags of a call of an operator route: the same four as `keys rotate`. */
const OPERATOR_OPTIONS = {
  ...COMMON_OPTIONS,
  "base-path": { type: "string" },
  "token-env": { type: "string" },
  "token-file": { type: "string" },
  timeout: { type: "string" },
} as const;

const STATUS_OPTIONS = OPERATOR_OPTIONS;

const REWRAP_OPTIONS = {
  ...OPERATOR_OPTIONS,
  limit: { type: "string" },
  "max-calls": { type: "string" },
  yes: { type: "boolean" },
  "no-input": { type: "boolean" },
} as const;

/** The bytes of one value: 32, as `openssl rand -base64 32` of the runbook gives. */
export const SECRET_BYTES = 32;

/**
 * The chance of one draw under 120 bits is about 10^-36: 43 symbols from 6
 * or fewer of 64. The loop guards against a broken source, and a test proves
 * it with an injected source.
 */
export const MAX_DRAWS = 3;

// The two call limits live in rewrap-limits.ts, so the help reads them too.
export { DEFAULT_MAX_CALLS } from "../rewrap-limits.js";

/** A version is digits only; the range check comes after. */
const WHOLE_NUMBER = /^\d+$/;

const SUBCOMMANDS_USAGE = "secret has the subcommands status and rewrap, or no positional";

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

/** A whole number flag from 1 to `max`, or its default, or a usage error. */
function countOf(flag: string, value: string | undefined, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = WHOLE_NUMBER.test(value) ? Number(value) : Number.NaN;
  if (!(n >= 1 && n <= max)) throw new UsageError(`--${flag} is a whole number from 1 to ${max}`);
  return n;
}

/**
 * The target of an operator call: the base URL, the base path, and the time
 * limit. The base is https, or http on this machine only, because the
 * request carries a secret. Each is a usage error before any read of the
 * secret.
 */
function readTarget(
  target: string | undefined,
  values: OperatorValues,
): { base: string; basePath: string; ms: number } {
  return {
    base: baseOf(target),
    basePath: basePathOf(values["base-path"]),
    ms: timeoutOf(values.timeout),
  };
}

type VersionCount = SecretStatusJson["versions"][number];

/** The seven keys of one entry of the status answer, each with its type. */
const COUNT_KEYS = {
  version: "number",
  configured: "boolean",
  current: "boolean",
  totpSecrets: "number",
  backupCodes: "number",
  signingKeys: "number",
  emailCodes: "number",
} as const;

/** The entries of a status answer, or null when the body is not a list of version counts. */
function versionCounts(body: unknown): VersionCount[] | null {
  const versions = (body as { versions?: unknown } | null)?.versions;
  if (typeof body !== "object" || body === null || !Array.isArray(versions)) return null;
  const out: VersionCount[] = [];
  for (const entry of versions as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    for (const [key, type] of Object.entries(COUNT_KEYS)) {
      const v = e[key];
      if (typeof v !== type) return null;
      if (type === "number" && !Number.isSafeInteger(v)) return null;
    }
    out.push({
      version: e.version as number,
      configured: e.configured as boolean,
      current: e.current as boolean,
      totpSecrets: e.totpSecrets as number,
      backupCodes: e.backupCodes as number,
      signingKeys: e.signingKeys as number,
      emailCodes: e.emailCodes as number,
    });
  }
  return out;
}

/** True when a version has a row of any of the four counts. */
const hasRows = (v: VersionCount) =>
  v.totpSecrets + v.backupCodes + v.signingKeys + v.emailCodes > 0;

/**
 * `authtempo secret status <base url>` (plan 11c2, spec 19 item 17): the
 * counts of `GET <basePath>/operator/secrets/status`, one line per version.
 * Exit 1 when a version that the config does not hold has rows. Its rows
 * cannot open until the version is back (spec 22 item 9).
 */
async function runStatus(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: STATUS_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(STATUS_OPTIONS),
  );
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  const t = readTarget(target, values);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/secrets/status";
  ctx.err(`reading ${t.base}${t.basePath}${path}`);
  const body = await operatorCall(ctx, { ...t, path, method: "GET", secret });
  const versions = versionCounts(body);
  if (versions === null)
    throw new Stop(`GET ${t.base}${t.basePath}${path} answered 200 with no list of version counts`);
  const json = values.json === true;
  if (!json)
    for (const v of versions)
      ctx.out(
        `version ${v.version}: ${v.current ? "current" : "old"}, ${v.configured ? "configured" : "not configured"}, totpSecrets ${v.totpSecrets}, backupCodes ${v.backupCodes}, signingKeys ${v.signingKeys}, emailCodes ${v.emailCodes}`,
      );
  const orphans = versions.filter((v) => !v.configured && hasRows(v));
  for (const v of orphans)
    ctx.err(
      `warning: version ${v.version} is not in the config but has rows; add it back before you remove it (spec 22 item 9)`,
    );
  const exit = orphans.length > 0 ? 1 : 0;
  if (json) printJson(ctx, { versions, exit, stopped: null } satisfies SecretStatusJson);
  return exit;
}

/** One answer of the rewrap route, as `api.secrets.rewrap` answers it (spec 22 item 6). */
interface RewrapAnswer {
  resealed: number;
  failed: number;
  skipped: number;
  more: boolean;
  next: string | null;
}

/** The answer of a rewrap call, or null when the body is not one. */
function rewrapAnswer(body: unknown): RewrapAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
  if (!count(b.resealed) || !count(b.failed) || !count(b.skipped)) return null;
  if (typeof b.more !== "boolean") return null;
  if (b.next !== null && typeof b.next !== "string") return null;
  return { resealed: b.resealed, failed: b.failed, skipped: b.skipped, more: b.more, next: b.next };
}

/**
 * `authtempo secret rewrap <base url>` (plan 11c2, spec 19 item 17): the
 * loop over `POST <basePath>/operator/secrets/rewrap`. Each call reads up to
 * `--limit` rows after the cursor of the call before. The loop sends each
 * `next` back as `after` (spec 22 item 6, ruling 6 of this plan). So a row
 * that fails or is skipped at the head of a pass blocks no row behind it.
 * The loop ends when `more` is false, when `next` is null, or when the
 * calls reach `--max-calls`. A null `next` means the pass read every row
 * that was left. A call that reseals 0 rows does not end the loop. A page
 * of skipped setups is not the end (spec 19 item 17 predates the cursor).
 * It exits 1 when a row did not open or rows remain. A stop in the middle
 * keeps the sums of the calls before it in the stop document.
 */
async function runRewrap(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: REWRAP_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(REWRAP_OPTIONS),
  );
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  const t = readTarget(target, values);
  const limit = countOf("limit", values.limit, REWRAP_LIMIT.max, REWRAP_LIMIT.default);
  const maxCalls = countOf("max-calls", values["max-calls"], MAX_CALLS_MAX, DEFAULT_MAX_CALLS);
  const yes = values.yes === true;
  const json = values.json === true;
  // Before any read of the secret and any request: a run that cannot ask must say yes.
  if (!yes && (!ctx.stdinIsTTY || values["no-input"] === true))
    throw new UsageError(
      "secret rewrap asks for a confirmation: give --yes when no person can answer",
    );
  // The secret reads stdin to its end, so the question would read an ended stream.
  if (!yes && values["token-file"] === "-")
    throw new UsageError(
      "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
    );
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/secrets/rewrap";
  ctx.err(`resealing the old rows of ${t.base} under the current secret, ${limit} rows a call`);
  if (!yes && !(await ctx.confirm("Reseal the old rows under the current secret?")))
    throw new Stop("no reseal: the answer was not yes");
  ctx.err(`posting ${t.base}${t.basePath}${path}`);
  const sums = { calls: 0, resealed: 0, failed: 0, skipped: 0, more: false };
  let after: string | null = null;
  /** Why the loop ended: no row left, the end of the pass, or the limit of calls. */
  let ended: "done" | "pass" | "max" = "max";
  try {
    while (sums.calls < maxCalls) {
      const body = await operatorCall(ctx, {
        ...t,
        path,
        method: "POST",
        body: { limit, ...(after === null ? {} : { after }) },
        secret,
      });
      const answer = rewrapAnswer(body);
      if (answer === null)
        throw new Stop(`POST ${t.base}${t.basePath}${path} answered 200 with no rewrap answer`);
      sums.calls++;
      sums.resealed += answer.resealed;
      sums.failed += answer.failed;
      sums.skipped += answer.skipped;
      sums.more = answer.more;
      ctx.err(
        `call ${sums.calls}: resealed ${answer.resealed}, failed ${answer.failed}, skipped ${answer.skipped}, more ${answer.more}`,
      );
      if (!answer.more) {
        ended = "done";
        break;
      }
      if (answer.next === null) {
        ended = "pass";
        break;
      }
      after = answer.next;
    }
  } catch (e) {
    // A stop after a call that ran: the sums of the calls before it are the result.
    if (!(e instanceof Stop) || sums.calls === 0) throw e;
    ctx.err(`stopped: ${e.message}`);
    if (json) printJson(ctx, { ...sums, exit: 2, stopped: e.message } satisfies SecretRewrapJson);
    return 2;
  }
  if (!json)
    ctx.out(
      `calls ${sums.calls}, resealed ${sums.resealed}, failed ${sums.failed}, skipped ${sums.skipped}, more ${sums.more}`,
    );
  if (sums.failed > 0)
    ctx.err(
      `warning: ${sums.failed} ${sums.failed === 1 ? "row" : "rows"} did not open or did not write; read the log of the deployment, then run it again`,
    );
  if (sums.more) {
    if (ended === "max")
      ctx.err(`warning: the run reached --max-calls ${maxCalls} with rows left; run it again`);
    else if (sums.skipped > 0)
      ctx.err(
        `warning: rows remain after the pass: ${sums.skipped} live ${sums.skipped === 1 ? "setup was" : "setups were"} skipped; wait 15 minutes, then run it again`,
      );
    else ctx.err("warning: rows remain after the pass; run it again");
  }
  const exit = sums.failed > 0 || sums.more ? 1 : 0;
  if (json) printJson(ctx, { ...sums, exit, stopped: null } satisfies SecretRewrapJson);
  return exit;
}

/**
 * `authtempo secret` (plan 11c2): a new app secret or operator secret from
 * 32 bytes of the Web Crypto source. The value goes to stdout once, or to a
 * new file with mode 0600, never both and never to stderr. After that one
 * write the value joins the scrub list, so no later line can carry it.
 */
async function runGenerator(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(OPTIONS),
  );
  if (positionals.length > 0) throw new UsageError(SUBCOMMANDS_USAGE);
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
}

/**
 * `authtempo secret` and its subcommands (plan 11c2). The first word
 * chooses: `status` and `rewrap` run their own parser; a flag or nothing
 * runs the generator; any other positional is a usage error. `helpOf` in
 * main.ts reads the same first word for the help and the stop document.
 */
export const secretCommand: Command = {
  help: SECRET_HELP,
  options: OPTIONS,
  subcommands: {
    status: { help: SECRET_STATUS_HELP, options: STATUS_OPTIONS },
    rewrap: { help: SECRET_REWRAP_HELP, options: REWRAP_OPTIONS },
  },
  async run(argv, ctx) {
    const [first, ...rest] = argv;
    if (first === "status") return runStatus(rest, ctx);
    if (first === "rewrap") return runRewrap(rest, ctx);
    return runGenerator(argv, ctx);
  },
};
