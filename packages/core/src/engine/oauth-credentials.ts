import type { ResolvedConfig } from "../config.js";
import { ACCESS_TOKEN_TYPE } from "../primitives/credentials.js";
import { randomBase64Url } from "../primitives/crypto.js";
import type { OAuthClientRow } from "../schema.js";
import { issuerOf, signToken } from "./jwt.js";
import type { AuthedClient } from "./oauth-client-auth.js";
import { findClient } from "./oauth-clients.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import type { TokenAnswer } from "./oauth-token.js";

/**
 * The `client_credentials` grant (plan 12e, RFC 6749 section 4.4, read
 * 2026-10-20). A confidential client gets an access token that acts for no
 * user: `sub` is its client id (RFC 9068 section 2.2). No refresh token
 * comes with it (section 4.4.3), and no ID token, because no user signed in.
 */

/** The grant type of RFC 6749 section 4.4.2. */
export const CREDENTIALS_GRANT = "client_credentials";
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
  /** The key thumbprint of a DPoP-bound token. Always null until plan 12e Task 9. */
  dpopJkt: string | null;
}

/**
 * True while a client may hold tokens of this grant for `scopes`. The client
 * is confidential, its `grantTypes` hold the grant, and its
 * `credentialsScopes` hold each scope. A metadata document never gets the
 * grant: its reader drops it (ruling 24 of plan 12e).
 */
function holdsGrant(client: OAuthClientRow, scopes: readonly string[]): boolean {
  return (
    client.authMethod !== "none" &&
    client.grantTypes.includes(CREDENTIALS_GRANT) &&
    scopes.every((s) => client.credentialsScopes.includes(s))
  );
}

/**
 * `grant_type=client_credentials` for a client that `authenticateClient`
 * checked. `resource` is required: the token is for one resource (RFC
 * 8707). An absent `scope` gives every scope of `credentialsScopes`; an
 * asked scope outside them, or an empty set, is `invalid_scope` (RFC 6749
 * section 3.3). `dpop` is null until plan 12e Task 9 binds the token.
 */
export async function credentialsGrant(
  config: ResolvedConfig,
  input: { client: AuthedClient; scope: string | null; resource: string | null; dpop: null },
): Promise<OAuthResult<TokenAnswer>> {
  const oauth = oauthOf(config);
  const { client, confidential } = input.client;
  if (!confidential || !holdsGrant(client, [])) return oauthFail("unauthorized_client");
  if (
    !(await config.limiter.allow(`oauth-credentials:client:${client.id}`, CREDENTIALS_PER_CLIENT))
  )
    return oauthFail("rate_limited");
  if (input.resource === null || !oauth.resources.includes(input.resource))
    return oauthFail("invalid_target");
  const scopes =
    input.scope === null
      ? [...client.credentialsScopes]
      : [...new Set(input.scope.split(" ").filter((s) => s.length > 0))];
  if (scopes.length === 0 || !holdsGrant(client, scopes)) return oauthFail("invalid_scope");
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
  });
  return oauthOk({ access_token: access, token_type: "Bearer", expires_in: exp - iat, scope });
}

/**
 * The client caller of a verified access token of this grant, or null. The
 * client must still exist and still hold the grant and each scope. So a
 * delete or an update of the client ends its tokens at once.
 */
export async function clientAccessOf(
  config: ResolvedConfig,
  token: { clientId: string; scopes: string[]; resource: string; jti: string; exp: number },
): Promise<OAuthClientAccess | null> {
  const client = await findClient(config, token.clientId);
  if (!client || !holdsGrant(client, token.scopes)) return null;
  return {
    clientId: token.clientId,
    scopes: token.scopes,
    resource: token.resource,
    tokenId: token.jti,
    expiresAt: new Date(token.exp * 1000),
    dpopJkt: null,
  };
}
