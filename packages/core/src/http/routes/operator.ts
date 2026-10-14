import type { ResolvedConfig } from "../../config.js";
import { rotateKey } from "../../engine/jwt.js";
import { isOperatorSecret } from "../../operator-secret.js";
import { constantTimeEqual, sha256Hex } from "../../primitives/crypto.js";
import { json } from "../json.js";
import type { Route } from "../router.js";

/**
 * The limit of the operator route (plan 11c): 5 calls per IP per hour,
 * right or wrong secret, in the app's limiter. A rotation is rare, so the
 * sixth call of an hour waits, and a guess costs one count of five.
 */
export const OPERATOR_PER_IP = { seconds: 3600, max: 5 };

/**
 * `Operator <secret>`. The scheme is case-insensitive (RFC 9110 section
 * 11.1). The secret has the form of `isOperatorSecret`, so a header of any
 * other form answers 401 with no hash.
 */
const OPERATOR_AUTH = /^Operator (\S+)$/i;

/**
 * The operator route (plan 11c). Off unless the config sets `operator`. The
 * secret is not an API token: no user owns it, and no session reaches it.
 * The answer `{ kid }` names the new signing key; the old key verifies for
 * 24 hours and signs nothing (`rotateKey`).
 */
export function operatorRoutes(config: ResolvedConfig): Route[] {
  const operator = config.operator;
  if (!operator) return [];
  return [
    {
      method: "POST",
      path: "/operator/keys/rotate",
      async handler(ctx) {
        // The limiter runs first, so every call counts, also one with no header.
        if (!(await config.limiter.allow(`operator:ip:${ctx.ip ?? "unknown"}`, OPERATOR_PER_IP)))
          return json({ error: "rate_limited" }, 429);
        const secret = OPERATOR_AUTH.exec(ctx.request.headers.get("authorization") ?? "")?.[1];
        // Core keeps the hash only, as for every token; the digests compare in constant time.
        if (
          !secret ||
          !isOperatorSecret(secret) ||
          !constantTimeEqual(await sha256Hex(secret), operator.secretHash)
        )
          return json({ error: "unauthorized" }, 401);
        return json(await rotateKey(config));
      },
    },
  ];
}
