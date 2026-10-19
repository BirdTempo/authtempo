import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { ACCESS_TOKEN_TYPE, SESSION_JWT_TYPE } from "../primitives/credentials.js";
import {
  constantTimeEqual,
  randomBase64Url,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { tokenHashClaim } from "../primitives/jwk.js";
import { resourceOf } from "../primitives/resource.js";
import type { OAuthTokenRow, UserRow, VerificationRow } from "../schema.js";
import { issuerOf, mintConfig, signToken, verifyLocal } from "./jwt.js";
import { consentCovers, type OAuthCodeData } from "./oauth-authorize.js";
import type { AuthedClient } from "./oauth-client-auth.js";
import { clientAccessOf, type OAuthClientAccess } from "./oauth-credentials.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import { consumeVerification } from "./verification.js";

/**
 * The token endpoint (plan 9g, spec 8.13 item 3): the code exchange with
 * PKCE (RFC 7636 section 4.6), the refresh rotation with family revocation
 * on reuse (draft-ietf-oauth-v2-1-16 section 4.3.1, read 2026-10-13),
 * revocation (RFC 7009, read 2026-10-13), and the access token check of the
 * resource server. An access token is a JWT with `typ: "at+jwt"` and the
 * claims of RFC 9068 section 2.2 (read 2026-10-13); it cannot be revoked and
 * lives `oauth.accessTtlMinutes`.
 */

// Moved to primitives/credentials.ts (plan 11d); still exported here.
export { ACCESS_TOKEN_TYPE };
export const REFRESH_PREFIX = "or_";
const REFRESH_RE = /^or_[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^oc_[A-Za-z0-9_-]{43}$/;
/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const TOKEN_PER_IP = { seconds: 900, max: 60 };
const DAY_MS = 86_400_000;

export interface TokenAnswer {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

/** The caller of a valid access token. */
export interface OAuthAccess {
  user: UserRow;
  clientId: string;
  scopes: string[];
  /** The token's `aud`: one of `oauth.resources`. */
  resource: string;
  /** The token's `jti`. */
  tokenId: string;
  expiresAt: Date;
}

interface Grant {
  user: UserRow;
  clientId: string;
  /** The scopes of this access token. */
  scopes: string[];
  /** The scopes of the grant, which a new refresh row keeps. */
  grantScopes: string[];
  resource: string;
  nonce: string | null;
  sessionId: string | null;
  /** The id of the code row at the code exchange; the family of the spent row at a refresh. */
  familyId: string;
  /** The spent refresh row at a refresh; null at the code exchange, which alone answers an ID token. */
  spentId: string | null;
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** The data of a code row, or null when a field is missing or of another type. */
function codeData(row: VerificationRow): OAuthCodeData | null {
  const d = row.data;
  if (!d) return null;
  const { clientId, redirectUri, scopes, resource, userId, sessionId } = d;
  const nullable = (v: unknown) => (v === null ? null : typeof v === "string" ? v : undefined);
  const nonce = nullable(d.nonce);
  const codeChallenge = nullable(d.codeChallenge);
  if (
    typeof clientId !== "string" ||
    typeof redirectUri !== "string" ||
    codeChallenge === undefined ||
    !strings(scopes) ||
    typeof resource !== "string" ||
    typeof userId !== "string" ||
    typeof sessionId !== "string" ||
    nonce === undefined
  )
    return null;
  return { clientId, redirectUri, codeChallenge, scopes, resource, userId, nonce, sessionId };
}

/**
 * True when the IP is past `TOKEN_PER_IP` at the token and revoke routes.
 * The route asks before the client auth, so a failed auth counts too.
 */
export const tokenLimited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-token:ip:${ipKey(ip)}`, TOKEN_PER_IP));

/** The user, while it exists and its address is verified. */
export async function liveUser(config: ResolvedConfig, userId: string): Promise<UserRow | null> {
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  return user?.emailVerified ? user : null;
}

/**
 * The scopes of a refresh grant that this config still serves, or null when
 * none is left but `offline_access` (ruling 30 of plan 12e). That scope only
 * keeps the grant, so a token of it alone serves nothing. The client then
 * starts a new authorization.
 */
export function servedGrantScopes(
  config: ResolvedConfig,
  scopes: readonly string[],
): string[] | null {
  const served = scopes.filter((s) => oauthOf(config).scopes.has(s));
  return served.some((s) => s !== "offline_access") ? served : null;
}

/** The refresh row of `token`, or null for a token of another form or an unknown one. */
export async function refreshRowOf(
  config: ResolvedConfig,
  token: string,
): Promise<OAuthTokenRow | null> {
  if (!REFRESH_RE.test(token)) return null;
  return config.storage.findOne("oauthToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
}

async function writeRefresh(
  config: ResolvedConfig,
  g: Grant,
  now: Date,
): Promise<{ token: string; id: string }> {
  const oauth = oauthOf(config);
  const token = randomToken(REFRESH_PREFIX);
  const id = newId(now);
  await config.storage.create("oauthToken", {
    id,
    tokenHash: await sha256Hex(token),
    familyId: g.familyId,
    userId: g.user.id,
    clientId: g.clientId,
    scopes: g.grantScopes,
    resource: g.resource,
    expiresAt: new Date(now.getTime() + oauth.refreshTtlDays * DAY_MS),
    usedAt: null,
    // Plan 12e Tasks 9 and 13 set these: the DPoP key and the spent parent row.
    parentId: null,
    dpopJkt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { token, id };
}

/**
 * True while the grant still stands: at a refresh, the spent row exists;
 * at the code exchange, the code row (its id is the family id) and the
 * consent of the user for the client exist. A grant revoke deletes the
 * consent and the refresh rows (`revokeGrant`); a reset or a password
 * change deletes the refresh rows and the code rows (`deleteOAuthTokens`).
 */
async function stillGranted(config: ResolvedConfig, g: Grant): Promise<boolean> {
  if (g.spentId !== null)
    return (
      (await config.storage.findOne("oauthToken", [
        { field: "id", op: "eq", value: g.spentId },
      ])) !== null
    );
  // A reset or a password change that ran during this exchange deleted the code row it spent.
  if (
    !(await config.storage.findOne("verification", [{ field: "id", op: "eq", value: g.familyId }]))
  )
    return false;
  return (
    (await config.storage.findOne("oauthConsent", [
      { field: "clientId", op: "eq", value: g.clientId },
      { field: "userId", op: "eq", value: g.user.id },
    ])) !== null
  );
}

/** The access token, a refresh token with `offline_access`, and an ID token with `openid` at the code exchange. */
async function issueTokens(config: ResolvedConfig, g: Grant): Promise<OAuthResult<TokenAnswer>> {
  const oauth = oauthOf(config);
  const { alg } = mintConfig(config);
  const now = config.clock.now();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + oauth.accessTtlMinutes * 60;
  const scope = g.scopes.join(" ");
  const issuer = issuerOf(config);
  const access = await signToken(config, ACCESS_TOKEN_TYPE, {
    iss: issuer,
    sub: g.user.id,
    aud: g.resource,
    client_id: g.clientId,
    scope,
    iat,
    exp,
    jti: randomBase64Url(16),
  });
  const answer: TokenAnswer = {
    access_token: access,
    token_type: "Bearer",
    expires_in: exp - iat,
    scope,
  };
  if (g.grantScopes.includes("offline_access")) {
    const fresh = await writeRefresh(config, g, now);
    // The race of refreshGrant: a reuse, a reset, or a grant revoke deleted
    // the family before this write, so the spent row is gone. At the code
    // exchange, a grant revoke deleted the consent. The new row goes too,
    // and the request fails.
    if (!(await stillGranted(config, g))) {
      try {
        await config.storage.delete("oauthToken", [{ field: "id", op: "eq", value: fresh.id }]);
      } catch (e) {
        // The row was never answered, so no client holds its token; the sweep
        // deletes it at its `expiresAt`. The answer stays `invalid_grant`.
        console.error(
          "authtempo: the delete of a refresh row in a revoked grant failed",
          fresh.id,
          e instanceof Error ? e.name : typeof e,
        );
      }
      return oauthFail("invalid_grant");
    }
    answer.refresh_token = fresh.token;
  }
  // OIDC Core 1.0 section 3.1.3.3: an ID token at the code exchange. A refresh answers none.
  if (g.spentId === null && g.scopes.includes("openid")) {
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: g.user.id,
      aud: g.clientId,
      iat,
      exp,
      at_hash: await tokenHashClaim(alg, access),
      ...(g.sessionId !== null ? { sid: g.sessionId } : {}),
      ...(g.nonce !== null ? { nonce: g.nonce } : {}),
    };
    if (g.scopes.includes("email")) {
      claims.email = g.user.email;
      claims.email_verified = g.user.emailVerified;
    }
    if (g.scopes.includes("profile")) {
      claims.name = g.user.name;
      claims.picture = g.user.image;
    }
    answer.id_token = await signToken(config, SESSION_JWT_TYPE, claims);
  }
  return oauthOk(answer);
}

/**
 * `grant_type=authorization_code` for an authenticated client (plan 12e:
 * the route runs `authenticateClient` first, so a failed auth spends
 * nothing). Then the consume spends the code, so a second exchange, or one with a wrong
 * client, redirect URI, or verifier, finds it spent: one code, one use.
 * The family id of the grant is the id of the code row, so a spent code
 * presented again deletes the family it gave (draft-ietf-oauth-v2-1-16
 * section 4.1.3, read 2026-10-13: the server SHOULD revoke the tokens of
 * a reused code). Two parallel exchanges can race: the loser deletes before
 * the winner writes, and that family stays. PKCE bounds the cost: only a
 * request that holds the verifier passes the checks after the consume, so
 * only a replay that holds the verifier can be the winner.
 */
export async function exchangeCode(
  config: ResolvedConfig,
  input: {
    code: string;
    /** Null when the form has no `code_verifier`. */
    codeVerifier: string | null;
    client: AuthedClient;
    redirectUri: string;
    resource: string | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  if (!CODE_RE.test(input.code)) return oauthFail("invalid_grant");
  const { client } = input.client;
  const valueHash = await sha256Hex(input.code);
  const consumed = await consumeVerification(config.storage, {
    purpose: "oauth-code",
    valueHash,
    now: config.clock.now(),
  });
  if (!consumed.ok) {
    await revokeReusedCode(config, valueHash);
    return oauthFail("invalid_grant");
  }
  const data = codeData(consumed.value);
  if (!data || data.clientId !== client.id || data.redirectUri !== input.redirectUri)
    return oauthFail("invalid_grant");
  // A code with no challenge is a confidential client's (`pkceRequired`).
  // A metadata document can change its method between the authorize step
  // and this exchange, so the client must be confidential here too.
  if (data.codeChallenge === null && !input.client.confidential) return oauthFail("invalid_grant");
  if (!(await verifierMatches(input.codeVerifier, data.codeChallenge)))
    return oauthFail("invalid_grant");
  if (input.resource !== null && input.resource !== data.resource)
    return oauthFail("invalid_target");
  const user = await liveUser(config, data.userId);
  if (!user) return oauthFail("invalid_grant");
  // Every code comes from a consent that covers its scopes. A grant revoke
  // after the authorize step deletes the consent, and the code gives nothing.
  if (!(await consentCovers(config, user.id, client.id, data.scopes)))
    return oauthFail("invalid_grant");
  return issueTokens(config, {
    user,
    clientId: client.id,
    scopes: data.scopes,
    grantScopes: data.scopes,
    resource: data.resource,
    nonce: data.nonce,
    sessionId: data.sessionId,
    familyId: consumed.value.id,
    spentId: null,
  });
}

/**
 * RFC 7636 section 4.6: the verifier of the code's challenge. A code with no
 * challenge (`pkceRequired`, plan 12e) takes no verifier: the RFC gives one
 * no meaning there, so a verifier is refused.
 */
async function verifierMatches(verifier: string | null, challenge: string | null) {
  if (challenge === null) return verifier === null;
  return (
    verifier !== null &&
    VERIFIER_RE.test(verifier) &&
    constantTimeEqual(await sha256Base64Url(verifier), challenge)
  );
}

/** Deletes every refresh token of one authorization. */
export async function revokeFamily(config: ResolvedConfig, familyId: string): Promise<void> {
  await config.storage.delete("oauthToken", [{ field: "familyId", op: "eq", value: familyId }]);
}

/**
 * A code that did not consume: when its row is spent, the family it gave
 * goes. An expired, unspent code gave none. The detection ends when the
 * sweep deletes the consumed code row after its `expiresAt`: a later reuse
 * finds no row and deletes nothing.
 */
async function revokeReusedCode(config: ResolvedConfig, valueHash: string): Promise<void> {
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "oauth-code" },
  ]);
  if (row && row.consumedAt !== null) await revokeFamily(config, row.id);
}

/** A spent refresh token presented again: someone holds a copy. The whole family goes. */
async function reuse(config: ResolvedConfig, row: OAuthTokenRow): Promise<OAuthResult<never>> {
  await revokeFamily(config, row.familyId);
  return oauthFail("invalid_grant");
}

/**
 * `grant_type=refresh_token`. Every check that can refuse runs before the
 * spend, so a refused request leaves the token usable. The spend is one
 * conditional update on `usedAt`; zero rows means a parallel request spent
 * it first, which is a reuse too. Two parallel refreshes race: the loser's
 * delete of the family can run before the winner writes its new row. So the
 * winner reads its spent row again after the write; when the row is gone,
 * the winner deletes its new row and answers `invalid_grant`. In each order
 * the family ends with no live row.
 */
export async function refreshGrant(
  config: ResolvedConfig,
  input: {
    refreshToken: string;
    /** The client of the request, which `authenticateClient` checked (plan 12e). */
    client: AuthedClient;
    scope: string | null;
    resource: string | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  const client = input.client.client;
  const row = await refreshRowOf(config, input.refreshToken);
  if (!row || row.clientId !== client.id) return oauthFail("invalid_grant");
  if (row.usedAt !== null) return reuse(config, row);
  const now = config.clock.now();
  if (row.expiresAt.getTime() <= now.getTime()) return oauthFail("invalid_grant");
  // A deploy can drop a scope. The new token gets the served scopes only,
  // because resolveAccessToken refuses any other scope.
  const served = servedGrantScopes(config, row.scopes);
  if (!served) return oauthFail("invalid_grant");
  let scopes = served;
  if (input.scope !== null) {
    const asked = [...new Set(input.scope.split(" ").filter((s) => s.length > 0))];
    if (asked.length === 0 || asked.some((s) => !served.includes(s)))
      return oauthFail("invalid_scope");
    scopes = asked;
  }
  if (input.resource !== null && input.resource !== row.resource)
    return oauthFail("invalid_target");
  // The auth read the client: a CIMD document that did not answer refused this refresh there, and the family stays.
  const user = await liveUser(config, row.userId);
  if (!user) return reuse(config, row);
  const spent = await config.storage.update(
    "oauthToken",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "usedAt", op: "eq", value: null },
    ],
    { usedAt: now, updatedAt: now },
  );
  if (spent !== 1) return reuse(config, row);
  return issueTokens(config, {
    user,
    clientId: row.clientId,
    scopes,
    grantScopes: row.scopes,
    resource: row.resource,
    nonce: null,
    sessionId: null,
    familyId: row.familyId,
    spentId: row.id,
  });
}

/**
 * RFC 7009 (read 2026-10-14). `client` is the client that
 * `authenticateClient` checked, or null when the request names none. A
 * refresh token's family goes when `client` is its client. With no client,
 * it goes only when its client is public. A confidential client
 * authenticates (section 2.1; plan 12e): with no client the answer is
 * `invalid_client`, and nothing goes. Another client answers `unauthorized_client` and
 * revokes nothing (section 2.1: the server verifies that the token was
 * issued to the client; plan 9h, owner decision 1a). An unknown token
 * answers the same 200 as a revoked one (section 2.2). An access token
 * cannot be revoked: it is a JWT that lives at most `oauth.accessTtlMinutes`.
 */
export async function revokeToken(
  config: ResolvedConfig,
  input: { token: string; client: AuthedClient | null },
): Promise<OAuthResult<{ revoked: true }>> {
  const row = await refreshRowOf(config, input.token);
  if (row) {
    if (input.client === null) {
      const owner = await config.storage.findOne("oauthClient", [
        { field: "id", op: "eq", value: row.clientId },
      ]);
      if (owner !== null && owner.authMethod !== "none") return oauthFail("invalid_client");
    } else if (input.client.client.id !== row.clientId) return oauthFail("unauthorized_client");
    await revokeFamily(config, row.familyId);
  }
  return oauthOk({ revoked: true });
}

/** A valid access token: of a user (`oauth`), or of a client that acts for no user (`oauth-client`, plan 12e). */
export type ResolvedAccess =
  | { kind: "oauth"; access: OAuthAccess }
  | { kind: "oauth-client"; access: OAuthClientAccess };

/**
 * The caller of an access token, or null: a JWT that verifies under a key
 * of this instance, with `typ: "at+jwt"`, this issuer, an `aud` in
 * `oauth.resources`, and a live `exp`. Then a user that exists, with each
 * scope still in `oauth.scopes`. For a `client_credentials` token, a client
 * that still holds the grant and each scope. A session JWT of `GET /token`
 * and an ID token have `typ: "JWT"` and never pass.
 */
export async function resolveAccessToken(
  config: ResolvedConfig,
  token: string,
): Promise<ResolvedAccess | null> {
  const oauth = config.oauth;
  if (!oauth) return null;
  const d = await verifyLocal(config, token);
  if (!d || d.header.typ !== ACCESS_TOKEN_TYPE) return null;
  const p = d.payload;
  const now = Math.floor(config.clock.now().getTime() / 1000);
  if (p.iss !== issuerOf(config) || typeof p.aud !== "string" || !oauth.resources.includes(p.aud))
    return null;
  if (typeof p.exp !== "number" || p.exp <= now) return null;
  if (
    typeof p.sub !== "string" ||
    typeof p.client_id !== "string" ||
    typeof p.scope !== "string" ||
    typeof p.jti !== "string"
  )
    return null;
  const scopes = p.scope.split(" ").filter((s) => s.length > 0);
  // A user id is a ULID; a client id is a `cl_` token or an https URL. The two never collide (plan 12e).
  if (p.sub === p.client_id) {
    const access = await clientAccessOf(config, {
      clientId: p.client_id,
      scopes,
      resource: p.aud,
      jti: p.jti,
      exp: p.exp,
    });
    return access ? { kind: "oauth-client", access } : null;
  }
  // Each scope must still be a scope of this config, as for a client token (ruling 29 of plan 12e).
  if (!scopes.every((s) => oauth.scopes.has(s))) return null;
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: p.sub }]);
  if (!user) return null;
  return {
    kind: "oauth",
    access: {
      user,
      clientId: p.client_id,
      scopes,
      resource: p.aud,
      tokenId: p.jti,
      expiresAt: new Date(p.exp * 1000),
    },
  };
}

/** The userinfo claims by scope (OIDC Core 1.0 section 5.3), or null without `openid`. */
export function userinfoClaims(access: OAuthAccess): Record<string, unknown> | null {
  if (!access.scopes.includes("openid")) return null;
  const { user } = access;
  return {
    sub: user.id,
    ...(access.scopes.includes("email")
      ? { email: user.email, email_verified: user.emailVerified }
      : {}),
    ...(access.scopes.includes("profile") ? { name: user.name, picture: user.image } : {}),
  };
}

/**
 * The configured resource that a request URL falls under, or null: a
 * resource on the request's origin whose path is the request's path or a
 * parent of it at a `/` boundary, the longest first. An access token passes
 * `auth.caller` only for this resource (RFC 8707: the `aud` is the resource).
 */
export function requestResource(
  config: ResolvedConfig,
  request: Pick<Request, "url">,
): string | null {
  const oauth = config.oauth;
  if (!oauth) return null;
  return resourceOf(oauth.resources, request.url);
}
