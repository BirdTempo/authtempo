import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { rotateKey } from "../../engine/jwt.js";
import { rewrapSecrets, secretsStatus } from "../../engine/secrets.js";
import { ipKey } from "../../limiter/ip-key.js";
import { isOperatorSecret } from "../../operator-secret.js";
import { constantTimeEqual, sha256Hex } from "../../primitives/crypto.js";
import { SCHEMA_VERSION } from "../../schema.js";
import { VERSION } from "../../version.js";
import { json, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";

/**
 * The limit of the key rotation (plan 11c): 5 calls per IP per hour,
 * right or wrong secret, in the app's limiter. A rotation is rare, so the
 * sixth call of an hour waits, and a guess costs one count of five.
 */
export const OPERATOR_PER_IP = { seconds: 3600, max: 5 };

/**
 * The limit of the secret routes and the info route (plan 11c2). 120 per IP
 * per hour for status, rewrap, and info, with a right or a wrong secret. A
 * rewrap of 100 000 rows at 1000 rows per call needs 100 calls; the 5 per
 * hour of keys/rotate would take 20 hours. A guess costs one count of 120,
 * and the secret has at least 32 visible characters.
 */
export const OPERATOR_SECRETS_PER_IP = { seconds: 3600, max: 120 };

/**
 * `Operator <secret>`. The scheme is case-insensitive (RFC 9110 section
 * 11.1). The secret has the form of `isOperatorSecret`, so a header of any
 * other form answers 401 with no hash.
 */
const OPERATOR_AUTH = /^Operator (\S+)$/i;

/** The body of a rewrap: `limit` alone, a whole number. An empty body is `{}`. */
const rewrapBody = z.strictObject({ limit: z.number().int().optional() });

type Operator = NonNullable<ResolvedConfig["operator"]>;

/**
 * The one check of the operator secret, for every operator route. Core keeps
 * the hash only, as for every token; the digests compare in constant time.
 */
async function operatorAuthorized(ctx: RouteContext, operator: Operator): Promise<boolean> {
  const secret = OPERATOR_AUTH.exec(ctx.request.headers.get("authorization") ?? "")?.[1];
  return (
    secret !== undefined &&
    isOperatorSecret(secret) &&
    constantTimeEqual(await sha256Hex(secret), operator.secretHash)
  );
}

/** The parsed body of a rewrap, or null for a body that is not a limit. */
async function readRewrapBody(request: Request): Promise<{ limit?: number } | null> {
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
  return parsed.data.limit === undefined ? {} : { limit: parsed.data.limit };
}

/**
 * The operator routes (plans 11c and 11c2). Off unless the config sets
 * `operator`. The secret is not an API token: no user owns it, and no
 * session reaches it. `keys/rotate` exists only with `jwtMint`: its one
 * action rotates the signing key. The three routes of 11c2 answer counts
 * and key names, never a sealed value, a hash, or a config value. Each
 * route runs its limiter first, so every call counts, also one with no
 * header.
 */
export function operatorRoutes(config: ResolvedConfig): Route[] {
  const operator = config.operator;
  if (!operator) return [];
  const rotate: Route[] = config.jwtMint
    ? [
        {
          method: "POST",
          path: "/operator/keys/rotate",
          async handler(ctx) {
            if (!(await config.limiter.allow(`operator:ip:${ipKey(ctx.ip)}`, OPERATOR_PER_IP)))
              return json({ error: "rate_limited" }, 429);
            if (!(await operatorAuthorized(ctx, operator)))
              return json({ error: "unauthorized" }, 401);
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
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        if (!(await operatorAuthorized(ctx, operator))) return json({ error: "unauthorized" }, 401);
        return json(await secretsStatus(config));
      },
    },
    {
      method: "POST",
      path: "/operator/secrets/rewrap",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        if (!(await operatorAuthorized(ctx, operator))) return json({ error: "unauthorized" }, 401);
        const body = await readRewrapBody(ctx.request);
        if (body === null) return json({ error: "invalid_body" }, 400);
        return respond(await rewrapSecrets(config, body));
      },
    },
    {
      method: "GET",
      path: "/operator/info",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        if (!(await operatorAuthorized(ctx, operator))) return json({ error: "unauthorized" }, 401);
        return json({
          core: VERSION,
          schemaVersion: SCHEMA_VERSION,
          configKeys: config.configKeys,
        });
      },
    },
  ];
}
