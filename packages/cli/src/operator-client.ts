import { isOperatorSecret } from "@authtempo/core/operator-secret";
import { BODY_CAP_BYTES, textOf } from "./checks.js";
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
  /** The largest body that the call reads, in bytes. A larger body is a stop. Without it, `BODY_CAP_BYTES`. */
  maxBytes?: number;
  /**
   * The query of a GET (plan 12f). It goes in the URL only: no stop text
   * names it, because a search query can hold an address.
   */
  query?: Readonly<Record<string, string>>;
  /**
   * The calls per IP per hour of the route's limiter, for the 429 text
   * (plan 12f Task 12): `CALLS_PER_HOUR` for the routes of 11c2, and
   * `OPERATOR_USERS_PER_IP.max` for the user tools of 12f.
   */
  perHour: number;
  /**
   * The text of a 429 for a route with a limit beside the limit per IP
   * (plan 12f2 Task 6): the delete counts each actor too. Without it, the
   * text names `perHour` per IP.
   */
  limits?: string;
  /** The scope that the route needs (spec 26 item 3). The 403 text names it. */
  scope?: OperatorScope;
  /**
   * True for a route of the user, session, and audit tools of plan 12f.
   * Their 404 text names `operator.users` and the scope, not the secret
   * routes of 11c2.
   */
  tool?: boolean;
  /** What the command checks for an `invalid_body` answer: the text after the code. */
  invalid?: string;
}

/** The scopes of a named operator secret (spec 26 item 3). */
export type OperatorScope = "keys" | "secrets" | "users" | "sessions" | "audit" | "delete";

/**
 * The text of each refusal code that a write of plans 12f and 12f2 can
 * answer to a secret caller, by its cause. `operator_required` and `invalid_body` have
 * their own texts in `operatorCall`; 401, 404, and 429 have theirs by
 * status. The codes of `USER_ACTOR_CODES` are not here: core answers them
 * to a request with a session only, and the CLI always calls with a
 * secret. A test holds the keys equal to the codes of `ROUTES` by that rule.
 */
export const REFUSALS: Readonly<Record<string, string>> = {
  account_banned: "the user is banned; unban the user first",
  email_unverified:
    "the user has not verified the address; the platform role needs a verified address",
  member_limit: "the platform organization has its largest count of members",
  last_owner: "the user is the last owner of the platform organization; add another owner first",
  conflict: "another change of this user ran at the same time; read the user, then run it again",
  totp_not_enabled: "the user has no second factor on",
  hook_refused: "a hook of the deployment refused the act (hooks.operator.beforeAction)",
  hook_failed: "a hook of the deployment failed; read the log of the deployment",
  sole_owner:
    "the user is the last owner of an organization with other members, or of the platform organization; make another member an owner first",
  delete_too_large:
    "the account holds too many organizations to delete in one call on D1; delete the organizations that the user alone holds first",
};

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
 * The shared call of the operator routes: `secret status`, `secret
 * rewrap`, the deployment part of `info` (plan 11c2), and the commands of
 * plan 12f. It sends `Operator <secret>` through `fetchWithin`, which
 * follows no redirect. A 404, a 401, and a 429 are stops with their own
 * text. A 403 `operator_required` names the scope, and each other refusal
 * code of `REFUSALS` names its cause. Any other status, or a body that is
 * not JSON, is a stop that names the request with no query. A 200 answers
 * its parsed body, which the caller validates.
 */
export async function operatorCall(ctx: Ctx, call: OperatorCall): Promise<unknown> {
  const url = `${call.base}${call.basePath}${call.path}`;
  const query = call.query === undefined ? "" : new URLSearchParams(call.query).toString();
  const init: RequestInit = {
    method: call.method,
    headers: {
      authorization: `Operator ${call.secret}`,
      ...(call.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  };
  const res = await fetchWithin(ctx.fetch, query === "" ? url : `${url}?${query}`, init, call.ms);
  if (res.status === 404) {
    if (call.tool === true) {
      const why = "the operator user tools are off";
      throw new OperatorStop(
        404,
        why,
        `${why}: set operator.users and a secret with the ${call.scope ?? "users"} scope in the config of the deployment`,
      );
    }
    const why = "the operator route is off, or core is older than 11c2";
    throw new OperatorStop(
      404,
      why,
      `${why}: set operator.secretHash in the config of the deployment`,
    );
  }
  if (res.status === 401) throw new OperatorStop(401, "the deployment refused the operator secret");
  if (res.status === 429) {
    const why = call.limits ?? `the operator routes allow ${call.perHour} calls per IP per hour`;
    throw new OperatorStop(429, why, `${why}; wait, then run it again`);
  }
  // The capped reader of the checks: it cancels the stream at the cap, so a
  // deployment cannot push bytes into memory until the time limit ends.
  const cap = call.maxBytes ?? BODY_CAP_BYTES;
  let text: string;
  try {
    text = await textOf(res, `${call.method} ${url}`, cap);
  } catch (e) {
    if (!(e instanceof HostError)) throw e;
    throw new OperatorStop(res.status, `the answer is larger than ${cap / 1024} KiB`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const code = res.status === 200 ? undefined : (body as { error?: unknown } | null)?.error;
  if (code === "operator_required" && res.status === 403)
    throw new OperatorStop(
      403,
      call.scope === undefined
        ? "the operator secret has no scope for this route"
        : `the operator secret has no ${call.scope} scope`,
    );
  if (code === "invalid_body" && res.status === 400)
    throw new OperatorStop(
      400,
      `the deployment refused a value (invalid_body)${call.invalid === undefined ? "" : `: ${call.invalid}`}`,
    );
  if (typeof code === "string" && Object.hasOwn(REFUSALS, code))
    throw new OperatorStop(res.status, REFUSALS[code] ?? code);
  if (res.status !== 200 || body === undefined)
    throw new OperatorStop(
      res.status,
      "no operator answer",
      `${call.method} ${url} answered ${res.status} with no operator answer`,
    );
  return body;
}
