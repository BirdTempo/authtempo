import { Stop } from "./errors.js";
import { fetchWithin } from "./net.js";
import type { Ctx } from "./output.js";

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
  if (res.status === 404)
    throw new Stop(
      "the operator route is off, or core is older than 11c2: set operator.secretHash in the config of the deployment",
    );
  if (res.status === 401) throw new Stop("the deployment refused the operator secret");
  if (res.status === 429)
    throw new Stop(
      `the operator routes allow ${CALLS_PER_HOUR} calls per IP per hour; wait, then run it again`,
    );
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status !== 200 || body === undefined)
    throw new Stop(`${call.method} ${url} answered ${res.status} with no operator answer`);
  return body;
}
