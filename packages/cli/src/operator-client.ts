import { isOperatorSecret } from "@authtempo/core/operator-secret";
import { textOf } from "./checks.js";
import { Stop, UsageError } from "./errors.js";
import { fetchWithin, HostError } from "./net.js";
import type { Ctx } from "./output.js";
import { DEFAULT_TOKEN_ENV, readSecret } from "./secrets.js";

/** One call of an operator route of core (plan 11c2). */
export interface OperatorCall {
  /** The origin of the deployment, as `baseOf` answers it. */
  base: string;
  /** The `basePath` of the deployment, as `basePathOf` answers it. */
  basePath: string;
  /** The path under the base path, such as `/operator/secrets/status`. */
  path: string;
  method: "GET" | "POST";
  /** The JSON body of a POST. */
  body?: unknown;
  /** The operator secret. It goes in the header only, and the caller has it in the scrub list. */
  secret: string;
  /** The time limit of the request in milliseconds. */
  ms: number;
  /** The largest body that the call reads, in bytes. A larger body is a stop. Without it, no limit. */
  maxBytes?: number;
}

/** The parsed values of the four operator flags of `OPERATOR_FLAGS`. */
export interface OperatorValues {
  "base-path"?: string | undefined;
  "token-env"?: string | undefined;
  "token-file"?: string | undefined;
  timeout?: string | undefined;
}

/**
 * The operator secret through `readSecret`, so it is in the scrub list. A
 * secret that fails core's own rule is refused before any request, as
 * `keys rotate` does. One function for `secret status`, `secret rewrap`,
 * and `info`.
 */
export function readOperatorSecret(ctx: Ctx, values: OperatorValues): string {
  const secret = readSecret(ctx, {
    envFlag: "token-env",
    fileFlag: "token-file",
    env: values["token-env"],
    file: values["token-file"],
    defaultEnv: DEFAULT_TOKEN_ENV,
    what: "the operator secret",
  });
  // Core's own rule (one source). A value of another form costs one of the
  // 120 calls per hour and reads as a refusal. And fetch refuses a header
  // that is not ASCII with no answer.
  if (!isOperatorSecret(secret))
    throw new UsageError(
      "the operator secret is 32 to 512 visible ASCII characters; the deployment refuses any other value",
    );
  return secret;
}

/**
 * A stop of an operator call with the HTTP status of the answer (plan
 * 11c2). `message` is the `stopped:` line of `secret status` and `secret
 * rewrap`, and can name the URL. `why` names no URL and no host: `info`
 * prints it with the status in an unread part.
 */
export class OperatorStop extends Stop {
  readonly status: number;
  readonly why: string;
  constructor(status: number, why: string, message = why) {
    super(message);
    this.name = "OperatorStop";
    this.status = status;
    this.why = why;
  }
}

/**
 * The limit of the three routes of plan 11c2: 120 calls per IP per hour. A
 * copy of `OPERATOR_SECRETS_PER_IP.max` in core's `src/http/routes/operator.ts`
 * (read 2026-10-19), because no entry of core that the CLI reads exports it.
 * The number is in a stop text only, as the 5 of `keys rotate` is.
 */
const CALLS_PER_HOUR = 120;

/**
 * The shared call of the operator routes of plan 11c2: `secret status`,
 * `secret rewrap`, and the deployment part of `info`. It sends `Operator
 * <secret>` through `fetchWithin`, which follows no redirect. A 404, a 401,
 * and a 429 are stops with their own text. Any other status, or a body that
 * is not JSON, is a stop that names the request. A 200 answers its parsed
 * body, which the caller validates.
 */
export async function operatorCall(ctx: Ctx, call: OperatorCall): Promise<unknown> {
  const url = `${call.base}${call.basePath}${call.path}`;
  const init: RequestInit = {
    method: call.method,
    headers: {
      authorization: `Operator ${call.secret}`,
      ...(call.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  };
  const res = await fetchWithin(ctx.fetch, url, init, call.ms);
  if (res.status === 404) {
    const why = "the operator route is off, or core is older than 11c2";
    throw new OperatorStop(
      404,
      why,
      `${why}: set operator.secretHash in the config of the deployment`,
    );
  }
  if (res.status === 401) throw new OperatorStop(401, "the deployment refused the operator secret");
  if (res.status === 429) {
    const why = `the operator routes allow ${CALLS_PER_HOUR} calls per IP per hour`;
    throw new OperatorStop(429, why, `${why}; wait, then run it again`);
  }
  // The capped reader of the checks: it cancels the stream at the cap, so a
  // deployment cannot push bytes into memory until the time limit ends.
  let text: string;
  try {
    text = await textOf(res, `${call.method} ${url}`, call.maxBytes ?? Number.POSITIVE_INFINITY);
  } catch (e) {
    if (!(e instanceof HostError) || call.maxBytes === undefined) throw e;
    throw new OperatorStop(res.status, `the answer is larger than ${call.maxBytes / 1024} KiB`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (res.status !== 200 || body === undefined)
    throw new OperatorStop(
      res.status,
      "no operator answer",
      `${call.method} ${url} answered ${res.status} with no operator answer`,
    );
  return body;
}
