import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { KEYS_HELP } from "../help/keys.js";
import type { KeysJson } from "../json.js";
import { baseOf, basePathOf, fetchWithin, HostError, timeoutOf } from "../net.js";
import { type Ctx, printJson } from "../output.js";
import { readSecret } from "../secrets.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  "base-path": { type: "string" },
  "token-env": { type: "string" },
  "token-file": { type: "string" },
  timeout: { type: "string" },
  yes: { type: "boolean" },
  "no-input": { type: "boolean" },
} as const;

/**
 * The kids of a key set, or null on a 404. `cache-control: no-cache` asks a
 * cache in front of the deployment for a fresh copy.
 */
async function keySet(ctx: Ctx, url: string, ms: number): Promise<string[] | null> {
  const res = await fetchWithin(ctx.fetch, url, { headers: { "cache-control": "no-cache" } }, ms);
  if (res.status === 404) return null;
  const body = (await res.json().catch(() => null)) as { keys?: { kid?: unknown }[] } | null;
  if (res.status !== 200 || !Array.isArray(body?.keys))
    throw new HostError(`GET ${url} answered ${res.status} with no key set`);
  return body.keys.map((k) => String(k.kid));
}

/**
 * `authtempo keys rotate <base url>` (spec 19, owner decision 1). It calls
 * the operator route of core, reads the key set before and after, and
 * prints the new kid only.
 */
export const keysCommand: Command = {
  help: KEYS_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    const [sub, target, ...extra] = positionals;
    if (sub !== "rotate")
      throw new UsageError(
        sub === undefined
          ? "name a subcommand: rotate"
          : `keys has no subcommand ${sub}; it has rotate`,
      );
    if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
    const base = baseOf(target);
    const basePath = basePathOf(values["base-path"]);
    const ms = timeoutOf(values.timeout);
    const yes = values.yes === true;
    // Before any read of the secret and any request: a run that cannot ask must say yes.
    if (!yes && (!ctx.stdinIsTTY || values["no-input"] === true))
      throw new UsageError(
        "keys rotate asks for a confirmation: give --yes when no person can answer",
      );
    const secret = readSecret(ctx, {
      envFlag: "token-env",
      fileFlag: "token-file",
      env: values["token-env"],
      file: values["token-file"],
      defaultEnv: "AUTHTEMPO_OPERATOR_SECRET",
      what: "the operator secret",
    });
    ctx.err(`rotating the signing key of ${base}; the old key verifies for 24 hours`);
    if (!yes && !(await ctx.confirm("Rotate the signing key?")))
      throw new Stop("no rotation: the answer was not yes");
    const jwks = `${base}${basePath}/jwks`;
    ctx.err(`reading ${jwks}`);
    if ((await keySet(ctx, jwks, ms)) === null)
      throw new Stop(
        `jwt minting is off, or no deployment answers at ${base}${basePath}: GET ${jwks} answered 404`,
      );
    const url = `${base}${basePath}/operator/keys/rotate`;
    ctx.err(`posting ${url}`);
    const res = await fetchWithin(
      ctx.fetch,
      url,
      { method: "POST", headers: { authorization: `Operator ${secret}` } },
      ms,
    );
    if (res.status === 404)
      throw new Stop(
        "the operator route is off: set operator.secretHash in the config of the deployment",
      );
    if (res.status === 401) throw new Stop("the deployment refused the operator secret");
    if (res.status === 429)
      throw new Stop("the operator route allows 5 calls per IP per hour; wait, then run it again");
    const body = (await res.json().catch(() => null)) as { kid?: unknown } | null;
    if (res.status !== 200 || typeof body?.kid !== "string")
      throw new Stop(`the operator route answered ${res.status} with no kid`);
    const kid = body.kid;
    const after = await keySet(ctx, jwks, ms);
    if (!after?.includes(kid))
      ctx.err(
        `warning: the key set does not list ${kid} yet; a cache can hold the old set for 300 seconds`,
      );
    if (values.json === true) printJson(ctx, { kid } satisfies KeysJson);
    else ctx.out(`kid: ${kid}`);
    return 0;
  },
};
