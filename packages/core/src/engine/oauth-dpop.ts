import type { ResolvedConfig } from "../config.js";
import { checkDpopProof, type DpopBinding } from "../primitives/dpop.js";
import { newId } from "../primitives/ids.js";
import type { OAuthClientRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { issuerOf } from "./jwt.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import { replayHash } from "./verification.js";

/**
 * DPoP in the provider (plan 12e, RFC 9449 read 2026-10-20). This file
 * checks the proof of a token request and of a request with a bound access
 * token. It also keeps the replay store. A proof is a credential: no code
 * here logs one.
 */

/**
 * Spends the `jti` of a proof of key `jkt`, or answers false for a `jti`
 * that the key spent before. The replay store is the database. The default
 * limiter can be per isolate, and a store that sees one isolate is not a
 * control (plan 12e). The unique key on `valueHash` refuses a second use on
 * every instance over the same storage. The row lives to `ceil(iat)` plus
 * twice the window: past the last second that the `iat` check passes, so
 * no sweep frees a live `jti`.
 */
export async function spendDpopJti(
  config: ResolvedConfig,
  jkt: string,
  jti: string,
  iat: number,
): Promise<boolean> {
  const { windowSeconds } = oauthOf(config).dpop;
  const at = config.clock.now();
  try {
    await config.storage.create("verification", {
      id: newId(at),
      purpose: "dpop-proof",
      identifier: jkt,
      valueHash: await replayHash("dpop-proof", jkt, jti),
      expiresAt: new Date((Math.ceil(iat) + 2 * windowSeconds) * 1000),
      consumedAt: null,
      data: null,
      createdAt: at,
      updatedAt: at,
      secretVersion: config.keyring.current,
    });
    return true;
  } catch (e) {
    if (e instanceof StorageError && e.code === "unique_violation") return false;
    throw e;
  }
}

/**
 * The proof of `request` for `url`, checked and spent. A resource request
 * passes its `token` and the key of the token.
 */
async function proofOf(
  config: ResolvedConfig,
  request: Request,
  url: string,
  bound?: { token: string; jkt: string },
): Promise<DpopBinding | null> {
  const proof = request.headers.get("dpop");
  if (proof === null) return null;
  const { algs, windowSeconds } = oauthOf(config).dpop;
  const r = await checkDpopProof({
    proof,
    method: request.method,
    url,
    ...(bound ? { accessToken: bound.token, jkt: bound.jkt } : {}),
    algs,
    windowSeconds,
    nowSeconds: Math.floor(config.clock.now().getTime() / 1000),
  });
  if (!r.ok || !(await spendDpopJti(config, r.jkt, r.jti, r.iat))) return null;
  return { jkt: r.jkt };
}

/**
 * The public URL of a route of core: the issuer and the route path. A Node
 * binding builds the request URL from the Host header, and a TLS proxy
 * changes its scheme. So core's own routes check `htu` against this URL
 * (ruling 31 of plan 12e).
 */
export const routeUrl = (config: ResolvedConfig, path: string): string =>
  `${issuerOf(config)}${path}`;

/**
 * The DPoP binding of a token request (RFC 9449 section 5): null with no
 * `DPoP` header, the key of a valid proof, or `invalid_dpop_proof`. A
 * client of `dpop_bound_access_tokens` must send a proof (section 5.2).
 */
export async function tokenDpop(
  config: ResolvedConfig,
  request: Request,
  client: OAuthClientRow,
): Promise<OAuthResult<DpopBinding | null>> {
  if (!request.headers.has("dpop"))
    return client.dpopBound ? oauthFail("invalid_dpop_proof") : oauthOk(null);
  const binding = await proofOf(config, request, routeUrl(config, "/oauth/token"));
  return binding ? oauthOk(binding) : oauthFail("invalid_dpop_proof");
}

/**
 * True when the request holds one valid proof of key `jkt` for `token` and
 * `url` (RFC 9449 section 7.1). The proof's `jti` is spent, so a replay fails.
 */
export async function resourceProofHolds(
  config: ResolvedConfig,
  request: Request,
  url: string,
  bound: { token: string; jkt: string },
): Promise<boolean> {
  return (await proofOf(config, request, url, bound)) !== null;
}

/** The DPoP scheme rule has one copy, in the credential facts of an SDK. */
export { readDpopToken } from "../primitives/credentials.js";

/** The `algs` parameter of a DPoP challenge (RFC 9449 section 7.1). */
export const dpopAlgs = (config: ResolvedConfig): string =>
  `algs="${oauthOf(config).dpop.algs.join(" ")}"`;
