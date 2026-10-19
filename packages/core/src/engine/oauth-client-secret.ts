import { constantTimeEqual, randomToken, sha256Hex } from "../primitives/crypto.js";
import type { ClientAuthMethod, OAuthClientRow } from "../schema.js";

/**
 * The client secret of the provider (plan 12e). The registration and
 * `api.oauth.clients` both make secrets here, so neither client module
 * imports the other for it.
 *
 * A client secret is `cs_` plus 32 random bytes (256 bits). The row holds its
 * SHA-256 hex, compared in constant time. A keyed hash adds nothing to 256
 * bits, and with no key an app secret rotation never ends a client secret
 * (spec 22 item 11).
 */

export const CLIENT_SECRET_PREFIX = "cs_";

/** A new secret and its hash for a secret method, or null for `none` and `private_key_jwt`. */
export async function newClientSecret(
  method: ClientAuthMethod,
): Promise<{ secret: string; hash: string } | null> {
  if (method !== "client_secret_basic" && method !== "client_secret_post") return null;
  const secret = randomToken(CLIENT_SECRET_PREFIX);
  return { secret, hash: await sha256Hex(secret) };
}

/**
 * True when `secret` is the client's secret, or its previous secret while
 * `previousSecretUntil` is after `now`. Both compares run in every case, so
 * the time does not tell which one passed.
 */
export async function secretMatches(
  row: Pick<OAuthClientRow, "secretHash" | "previousSecretHash" | "previousSecretUntil">,
  secret: string,
  now: Date,
): Promise<boolean> {
  const hash = await sha256Hex(secret);
  const current = constantTimeEqual(hash, row.secretHash ?? "");
  const previous = constantTimeEqual(hash, row.previousSecretHash ?? "");
  const previousLive =
    row.previousSecretUntil !== null && row.previousSecretUntil.getTime() > now.getTime();
  return (
    (row.secretHash !== null && current) ||
    (row.previousSecretHash !== null && previousLive && previous)
  );
}
