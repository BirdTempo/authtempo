import type { ResolvedConfig } from "../config.js";
import { ACCESS_TOKEN_TYPE } from "../primitives/credentials.js";
import { randomBase64Url } from "../primitives/crypto.js";
import type { DpopBinding } from "../primitives/dpop.js";
import type { OAuthClientRow } from "../schema.js";
import { issuerOf, signToken } from "./jwt.js";
import type { AuthedClient } from "./oauth-client-auth.js";
import { CREDENTIALS_GRANT, findClient } from "./oauth-clients.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import type { TokenAnswer } from "./oauth-token.js";

export { CREDENTIALS_GRANT };

/**
 * The `client_credentials` grant (plan 12e, RFC 6749 section 4.4, read
 * 2026-10-20). A confidential client gets an access token that acts for no
 * user: `sub` is its client id (RFC 9068 section 2.2). No refresh token
 * comes with it (section 4.4.3), and no ID token, because no user signed in.
 */

// A runaway loop of one client stops at 2 per second, also when it spreads over many IPs.
// oauth-token:ip counts first, so a service on one IP gets 60 tokens per 15 minutes.
// A service keeps its token until its expiry, so it needs far fewer (ruling 27 of plan 12e).
export const CREDENTIALS_PER_CLIENT = { seconds: 60, max: 120 };

/** The caller of a valid `client_credentials` access token: a client, and no user. */
export interface OAuthClientAccess {
  clientId: string;
  scopes: string[];
  /** The token's `aud`: one of `oauth.resources`. */
  resource: string;
  /** The token's `jti`. */
  tokenId: string;
  expiresAt: Date;
  /** The `cnf.jkt` of a DPoP-bound token (RFC 9449 section 6.1), or null. */
  dpopJkt: string | null;
}

/**
 * The scopes that a client of this grant may hold: each one is in its
 * `credentialsScopes` and in `oauth.scopes` (ruling 28 of plan 12e). A scope
 * that a deploy drops from the config leaves the set at once, on every
 * instance with that config.
 */
const servedScopes = (config: ResolvedConfig, client: OAuthClientRow) =>
  client.credentialsScopes.filter((s) => oauthOf(config).scopes.has(s));

/**
 * True while a client may hold tokens of this grant for `scopes`. The client
 * is confidential, its `grantTypes` hold the grant, and each scope is a
 * served scope. A metadata document never gets the grant: its reader drops
 * it (ruling 24 of plan 12e).
 */
function holdsGrant(
  config: ResolvedConfig,
  client: OAuthClientRow,
  scopes: readonly string[],
): boolean {
  const served = servedScopes(config, client);
  return (
    client.authMethod !== "none" &&
    client.grantTypes.includes(CREDENTIALS_GRANT) &&
    scopes.every((s) => served.includes(s))
  );
}

/**
 * `grant_type=client_credentials` for a client that `authenticateClient`
 * checked. `resource` is required: the token is for one resource (RFC
 * 8707). An absent `scope` gives every served scope. An asked scope that
 * is not served, or an empty set, is `invalid_scope` (RFC 6749 section 3.3).
 * With `dpop`, the token is bound to that key (RFC 9449 section 5).
 */
export async function credentialsGrant(
  config: ResolvedConfig,
  input: {
    client: AuthedClient;
    scope: string | null;
    resource: string | null;
    dpop: DpopBinding | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  const oauth = oauthOf(config);
  const { client, confidential } = input.client;
  if (!confidential || !holdsGrant(config, client, [])) return oauthFail("unauthorized_client");
  if (
    !(await config.limiter.allow(`oauth-credentials:client:${client.id}`, CREDENTIALS_PER_CLIENT))
  )
    return oauthFail("rate_limited");
  if (input.resource === null || !oauth.resources.includes(input.resource))
    return oauthFail("invalid_target");
  const scopes =
    input.scope === null
      ? servedScopes(config, client)
      : [...new Set(input.scope.split(" ").filter((s) => s.length > 0))];
  if (scopes.length === 0 || !holdsGrant(config, client, scopes)) return oauthFail("invalid_scope");
  const iat = Math.floor(config.clock.now().getTime() / 1000);
  const exp = iat + oauth.accessTtlMinutes * 60;
  const scope = scopes.join(" ");
  const access = await signToken(config, ACCESS_TOKEN_TYPE, {
    iss: issuerOf(config),
    sub: client.id,
    aud: input.resource,
    client_id: client.id,
    scope,
    iat,
    exp,
    jti: randomBase64Url(16),
    ...(input.dpop !== null ? { cnf: { jkt: input.dpop.jkt } } : {}),
  });
  return oauthOk({
    access_token: access,
    token_type: input.dpop !== null ? "DPoP" : "Bearer",
    expires_in: exp - iat,
    scope,
  });
}

/**
 * The client caller of a verified access token of this grant, or null. The
 * client must still exist and still hold the grant and each scope. So a
 * delete or an update of the client ends its tokens at once.
 */
export async function clientAccessOf(
  config: ResolvedConfig,
  token: {
    clientId: string;
    scopes: string[];
    resource: string;
    jti: string;
    exp: number;
    dpopJkt: string | null;
  },
): Promise<OAuthClientAccess | null> {
  const client = await findClient(config, token.clientId);
  if (!client || !holdsGrant(config, client, token.scopes)) return null;
  return {
    clientId: token.clientId,
    scopes: token.scopes,
    resource: token.resource,
    tokenId: token.jti,
    expiresAt: new Date(token.exp * 1000),
    dpopJkt: token.dpopJkt,
  };
}
