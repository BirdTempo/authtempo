import type { ResolvedConfig } from "../config.js";
import {
  constantTimeEqual,
  randomBase64Url,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { tokenHashClaim } from "../primitives/jwk.js";
import type { OAuthTokenRow, UserRow, VerificationRow } from "../schema.js";
import { issuerOf, mintConfig, signToken, verifyLocal } from "./jwt.js";
import { consentCovers, type OAuthCodeData } from "./oauth-authorize.js";
import { findClient } from "./oauth-clients.js";
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

export const ACCESS_TOKEN_TYPE = "at+jwt";
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
  const { clientId, redirectUri, codeChallenge, scopes, resource, userId, sessionId } = d;
  const nonce = d.nonce === null ? null : typeof d.nonce === "string" ? d.nonce : undefined;
  if (
    typeof clientId !== "string" ||
    typeof redirectUri !== "string" ||
    typeof codeChallenge !== "string" ||
    !strings(scopes) ||
    typeof resource !== "string" ||
    typeof userId !== "string" ||
    typeof sessionId !== "string" ||
    nonce === undefined
  )
    return null;
  return { clientId, redirectUri, codeChallenge, scopes, resource, userId, nonce, sessionId };
}

const limited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-token:ip:${ip ?? "unknown"}`, TOKEN_PER_IP));

/** The user, while it exists and its address is verified. */
async function liveUser(config: ResolvedConfig, userId: string): Promise<UserRow | null> {
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  return user?.emailVerified ? user : null;
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
    createdAt: now,
    updatedAt: now,
  });
  return { token, id };
}

/**
 * True while the grant still stands: at a refresh, the spent row exists;
 * at the code exchange, the consent of the user for the client exists. A
 * grant revoke deletes both (`revokeGrant`), and a reset or a password
 * change deletes the refresh rows (`deleteRefreshTokens`).
 */
async function stillGranted(config: ResolvedConfig, g: Grant): Promise<boolean> {
  if (g.spentId !== null)
    return (
      (await config.storage.findOne("oauthToken", [
        { field: "id", op: "eq", value: g.spentId },
      ])) !== null
    );
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
          "tempo-auth: the delete of a refresh row in a revoked grant failed",
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
    answer.id_token = await signToken(config, "JWT", claims);
  }
  return oauthOk(answer);
}

/**
 * `grant_type=authorization_code`. An unknown client spends nothing. Then
 * the consume spends the code, so a second exchange, or one with a wrong
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
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
    resource: string | null;
    ip: string | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  if (await limited(config, input.ip)) return oauthFail("rate_limited");
  if (!CODE_RE.test(input.code)) return oauthFail("invalid_grant");
  const client = await findClient(config, input.clientId);
  if (!client) return oauthFail("invalid_client");
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
  if (
    !VERIFIER_RE.test(input.codeVerifier) ||
    !constantTimeEqual(await sha256Base64Url(input.codeVerifier), data.codeChallenge)
  )
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
    clientId: string;
    scope: string | null;
    resource: string | null;
    ip: string | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  if (await limited(config, input.ip)) return oauthFail("rate_limited");
  if (!REFRESH_RE.test(input.refreshToken)) return oauthFail("invalid_grant");
  const row = await config.storage.findOne("oauthToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(input.refreshToken) },
  ]);
  if (!row || row.clientId !== input.clientId) return oauthFail("invalid_grant");
  if (row.usedAt !== null) return reuse(config, row);
  const now = config.clock.now();
  if (row.expiresAt.getTime() <= now.getTime()) return oauthFail("invalid_grant");
  let scopes = row.scopes;
  if (input.scope !== null) {
    const asked = [...new Set(input.scope.split(" ").filter((s) => s.length > 0))];
    if (asked.length === 0 || asked.some((s) => !row.scopes.includes(s)))
      return oauthFail("invalid_scope");
    scopes = asked;
  }
  if (input.resource !== null && input.resource !== row.resource)
    return oauthFail("invalid_target");
  // A CIMD document that does not answer now refuses this refresh and keeps the family.
  if (!(await findClient(config, row.clientId))) return oauthFail("invalid_client");
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
 * RFC 7009: a refresh token's family goes when `client_id` is absent or
 * names the token's client. Every other token, known or not, answers the
 * same 200 (section 2.2). An access token cannot be revoked: it is a JWT
 * that lives at most `oauth.accessTtlMinutes`.
 */
export async function revokeToken(
  config: ResolvedConfig,
  input: { token: string; clientId: string | null; ip: string | null },
): Promise<OAuthResult<{ revoked: true }>> {
  if (await limited(config, input.ip)) return oauthFail("rate_limited");
  if (REFRESH_RE.test(input.token)) {
    const row = await config.storage.findOne("oauthToken", [
      { field: "tokenHash", op: "eq", value: await sha256Hex(input.token) },
    ]);
    if (row && (input.clientId === null || input.clientId === row.clientId))
      await revokeFamily(config, row.familyId);
  }
  return oauthOk({ revoked: true });
}

/**
 * The caller of an access token, or null: a JWT that verifies under a key
 * of this instance, with `typ: "at+jwt"`, this issuer, an `aud` in
 * `oauth.resources`, a live `exp`, and a user that exists. A session JWT of
 * `GET /token` and an ID token have `typ: "JWT"` and never pass.
 */
export async function resolveAccessToken(
  config: ResolvedConfig,
  token: string,
): Promise<OAuthAccess | null> {
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
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: p.sub }]);
  if (!user) return null;
  return {
    user,
    clientId: p.client_id,
    scopes: p.scope.split(" ").filter((s) => s.length > 0),
    resource: p.aud,
    tokenId: p.jti,
    expiresAt: new Date(p.exp * 1000),
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
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestLength = -1;
  for (const resource of oauth.resources) {
    const r = new URL(resource);
    if (r.origin !== url.origin) continue;
    const base = r.pathname.replace(/\/$/, "");
    if (base !== "" && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) continue;
    if (base.length > bestLength) {
      best = resource;
      bestLength = base.length;
    }
  }
  return best;
}
