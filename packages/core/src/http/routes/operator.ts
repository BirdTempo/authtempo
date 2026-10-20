import type { OperatorScope, ResolvedConfig } from "../../config.js";
import { rotateKey } from "../../engine/jwt.js";
import { matchOperatorSecret, requireScope } from "../../engine/operator/guards.js";
import { rewrapSecrets, secretsStatus } from "../../engine/secrets.js";
import { ipKey } from "../../limiter/ip-key.js";
import { OPERATOR_PER_IP, OPERATOR_SECRETS_PER_IP } from "../../operator-secret.js";
import { SCHEMA_VERSION } from "../../schema.js";
import { VERSION } from "../../version.js";
import { rewrapBody } from "../contract/operator.js";
import { json, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";

/**
 * The one check of the operator secret, for every operator route of 11c
 * and 11c2: `matchOperatorSecret` plus a scope test (plan 12f). Null when
 * the secret matches an entry with `scope`; `scope` null needs a match
 * only. No match answers 401; a match with no scope answers 403
 * `operator_required`.
 */
async function operatorAuthorized(
  config: ResolvedConfig,
  ctx: RouteContext,
  scope: OperatorScope | null,
): Promise<Response | null> {
  const entry = await matchOperatorSecret(config, ctx.request);
  if (entry === null) return json({ error: "unauthorized" }, 401);
  if (scope === null) return null;
  const allowed = requireScope({ kind: "secret", name: entry.name, scopes: entry.scopes }, scope);
  return allowed.ok ? null : json({ error: allowed.code }, allowed.status);
}

/** The parsed body of a rewrap, or null for a body that is not a limit and a cursor. */
async function readRewrapBody(
  request: Request,
): Promise<{ limit?: number; after?: string } | null> {
  const text = await request.text();
  let raw: unknown = {};
  if (text !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = rewrapBody.safeParse(raw);
  if (!parsed.success) return null;
  const { limit, after } = parsed.data;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 * The operator routes (plans 11c and 11c2). Off unless the config sets
 * `operator`. The secret is not an API token: no user owns it, and no
 * session reaches it. `keys/rotate` exists only with `jwtMint`: its one
 * action rotates the signing key. The three routes of 11c2 answer counts
 * and key names, never a sealed value, a hash, or a config value. Each
 * route runs its limiter first, so every call counts, also one with no
 * header. Plan 12f: `keys/rotate` needs the scope keys, the secret routes
 * need the scope secrets, and the info route needs any entry, because it
 * gives no value.
 */
export function operatorRoutes(config: ResolvedConfig): Route[] {
  if (!config.operator) return [];
  const rotate: Route[] = config.jwtMint
    ? [
        {
          method: "POST",
          path: "/operator/keys/rotate",
          key: "POST /operator/keys/rotate",
          async handler(ctx) {
            if (!(await config.limiter.allow(`operator:ip:${ipKey(ctx.ip)}`, OPERATOR_PER_IP)))
              return json({ error: "rate_limited" }, 429);
            const refused = await operatorAuthorized(config, ctx, "keys");
            if (refused) return refused;
            // The answer `{ kid }` names the new signing key; the old key verifies for 24 hours and signs nothing.
            return json(await rotateKey(config));
          },
        },
      ]
    : [];
  return [
    ...rotate,
    {
      method: "GET",
      path: "/operator/secrets/status",
      key: "GET /operator/secrets/status",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        const refused = await operatorAuthorized(config, ctx, "secrets");
        if (refused) return refused;
        return json(await secretsStatus(config));
      },
    },
    {
      method: "POST",
      path: "/operator/secrets/rewrap",
      key: "POST /operator/secrets/rewrap",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        const refused = await operatorAuthorized(config, ctx, "secrets");
        if (refused) return refused;
        const body = await readRewrapBody(ctx.request);
        if (body === null) return json({ error: "invalid_body" }, 400);
        return respond(await rewrapSecrets(config, body));
      },
    },
    {
      method: "GET",
      path: "/operator/info",
      key: "GET /operator/info",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        const refused = await operatorAuthorized(config, ctx, null);
        if (refused) return refused;
        return json({
          core: VERSION,
          schemaVersion: SCHEMA_VERSION,
          configKeys: config.configKeys,
        });
      },
    },
  ];
}
