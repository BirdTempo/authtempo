import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { ACCESS_TOKEN_TYPE, SESSION_JWT_TYPE } from "../primitives/credentials.js";
import {
  constantTimeEqual,
  randomBase64Url,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../primitives/crypto.js";
import type { DpopBinding } from "../primitives/dpop.js";
import { newId } from "../primitives/ids.js";
import { tokenHashClaim } from "../primitives/jwk.js";
import { namedResource, resourceOf } from "../primitives/resource.js";
import { clientRef } from "../redact.js";
import type {
  OAuthClientRow,
  OAuthDeviceRow,
  OAuthTokenRow,
  UserRow,
  VerificationRow,
} from "../schema.js";
import { issuerOf, mintConfig, signToken, verifyLocal } from "./jwt.js";
import { consentCovers, type OAuthCodeData } from "./oauth-authorize.js";
import type { AuthedClient } from "./oauth-client-auth.js";
import { clientAccessOf, type OAuthClientAccess } from "./oauth-credentials.js";
import { familyEnded, familyStart, revokeFamily } from "./oauth-family.js";
import { linkIdToken } from "./oauth-logout.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import { sidFor, subjectFor, userOfSubject } from "./oauth-subject.js";
import { activeBan, bannedFor } from "./operator/ban-rule.js";
import { revokedFor } from "./operator/guards.js";
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
  /** `DPoP` for a token bound to the key of a proof (RFC 9449 section 5). */
  token_type: "Bearer" | "DPoP";
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
  /** The `cnf.jkt` of a DPoP-bound token (RFC 9449 section 6.1), or null. */
  dpopJkt: string | null;
}

interface Grant {
  user: UserRow;
  /** The client of the grant: its id and its subject type. */
  client: OAuthClientRow;
  /** The scopes of this access token. */
  scopes: string[];
  /** The scopes of the grant, which a new refresh row keeps. */
  grantScopes: string[];
  resource: string;
  nonce: string | null;
  sessionId: string | null;
  /** The `auth_time` of the ID token in seconds, or null: none (plan 12e). */
  authTime: number | null;
  /** The id of the code row at the code exchange; the family of the spent row at a refresh. */
  familyId: string;
  /** The spent refresh row at a refresh; null at the code exchange and the device poll, which alone answer an ID token. */
  spentId: string | null;
  /** The spent device row at a device poll (plan 12e); null for the other grants. */
  deviceId: string | null;
  /** The key of the request's proof: the access token gets `cnf.jkt` (plan 12e). */
  dpop: DpopBinding | null;
  /** The refresh row keeps the key of `dpop`: a public client's (RFC 9449 section 5). */
  bindRefresh: boolean;
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
  // A code of a core before plan 12e Task 9 has no dpopJkt and binds no key.
  const dpopJkt = d.dpopJkt === undefined ? null : nullable(d.dpopJkt);
  // A code of a core before plan 12e Task 12 has no authTime: its ID token has no auth_time.
  const authTime = d.authTime ?? null;
  if (
    typeof clientId !== "string" ||
    typeof redirectUri !== "string" ||
    codeChallenge === undefined ||
    !strings(scopes) ||
    typeof resource !== "string" ||
    typeof userId !== "string" ||
    typeof sessionId !== "string" ||
    nonce === undefined ||
    dpopJkt === undefined ||
    (authTime !== null && !Number.isSafeInteger(authTime))
  )
    return null;
  return {
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    resource,
    userId,
    nonce,
    sessionId,
    dpopJkt,
    authTime: authTime as number | null,
  };
}

/**
 * True when the IP is past `TOKEN_PER_IP` at the token and revoke routes.
 * The route asks before the client auth, so a failed auth counts too.
 */
export const tokenLimited = async (config: ResolvedConfig, ip: string | null) =>
  !(await limit(config, "oauth-token:ip", ipKey(ip), TOKEN_PER_IP));

/**
 * The user, while it exists, its address is verified, and no ban is active
 * (plan 12f). The refresh grant, the code exchange, the device poll, and
 * introspection read it. `issuedAt` is the time of the row that grants the
 * tokens. With it, the call also refuses a row from before the end of the
 * last ban (`bannedFor`, ruling 29). The ban deleted every such row, so it is a row
 * that a race wrote beside the ban. It gives no token after the unban or
 * the end either.
 */
export async function liveUser(
  config: ResolvedConfig,
  userId: string,
  issuedAt?: Date,
): Promise<UserRow | null> {
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  if (!user?.emailVerified || activeBan(user, config.clock.now())) return null;
  if (issuedAt && bannedFor(user, issuedAt)) return null;
  return user;
}

/**
 * True when a SCIM deactivate ended the access of the user after the family
 * of `row` began (ruling 55 of plan 12d). The deactivate ends the families
 * that fit its budget. A pending-end row names the rest until the sweep,
 * and this door refuses them, as `revokedFor` refuses a session. It reads
 * the start of the family, so a race row of an old family is refused too.
 * The refresh grant and introspection read it.
 */
export function familyRevoked(
  config: ResolvedConfig,
  user: UserRow,
  row: Pick<OAuthTokenRow, "familyId" | "createdAt">,
): Promise<boolean> {
  return revokedFor(config, user, { createdAt: familyStart(row) });
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

/**
 * The refresh row of `token`, or null for a token of another form, an
 * unknown one, or one of an ended family. The refresh grant, the revoke,
 * and introspection read rows here, so a row that a failed family delete
 * left behind serves none of them.
 */
export async function refreshRowOf(
  config: ResolvedConfig,
  token: string,
): Promise<OAuthTokenRow | null> {
  if (!REFRESH_RE.test(token)) return null;
  const row = await config.storage.findOne("oauthToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (row && (await familyEnded(config, row.familyId))) return null;
  return row;
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
    clientId: g.client.id,
    scopes: g.grantScopes,
    resource: g.resource,
    expiresAt: new Date(now.getTime() + oauth.refreshTtlDays * DAY_MS),
    usedAt: null,
    // The spent row of a refresh, so the reuse window finds its child; null at the code exchange.
    parentId: g.spentId,
    // RFC 9449 section 5: a public client's refresh token is bound to the key
    // of its proof. A confidential client's stays unbound: the client auth at
    // each refresh already ties it to the client.
    dpopJkt: g.bindRefresh && g.dpop !== null ? g.dpop.jkt : null,
    createdAt: now,
    updatedAt: now,
  });
  return { token, id };
}

/**
 * True while the grant still stands. At a refresh, the spent row exists.
 * At the code exchange, the code row (its id is the family id) exists, and
 * the consent of the user for the client exists. At a device poll, the
 * device row and the consent exist. A grant revoke deletes the consent, the
 * refresh rows, and the device rows (`revokeGrant`). A reset or a password
 * change deletes the refresh rows, the code rows, and the device rows
 * (`deleteOAuthTokens`).
 */
async function stillGranted(config: ResolvedConfig, g: Grant): Promise<boolean> {
  // This read runs after the write of the new row. See revokeFamily for why it closes the race.
  if (await familyEnded(config, g.familyId)) return false;
  if (g.spentId !== null)
    return (
      (await config.storage.findOne("oauthToken", [
        { field: "id", op: "eq", value: g.spentId },
      ])) !== null
    );
  if (g.deviceId !== null) {
    // The device row stays after its spend, as a code row does. A reset, a
    // change, or a grant revoke that ran during this poll deleted it.
    if (
      !(await config.storage.findOne("oauthDevice", [{ field: "id", op: "eq", value: g.deviceId }]))
    )
      return false;
  } else if (
    // A reset or a password change that ran during this exchange deleted the code row it spent.
    !(await config.storage.findOne("verification", [{ field: "id", op: "eq", value: g.familyId }]))
  )
    return false;
  return (
    (await config.storage.findOne("oauthConsent", [
      { field: "clientId", op: "eq", value: g.client.id },
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
  // A client without the refresh grant gets no refresh token (review m1 of plan 12e).
  // So its scope names no offline_access (RFC 6749 section 5.1, ruling 58).
  const refreshes = g.client.grantTypes.includes("refresh_token");
  const scope = (refreshes ? g.scopes : g.scopes.filter((s) => s !== "offline_access")).join(" ");
  const issuer = issuerOf(config);
  // The user id, or the pairwise subject of the client's sector (plan 12e).
  const sub = await subjectFor(config, g.user.id, g.client);
  const access = await signToken(config, ACCESS_TOKEN_TYPE, {
    iss: issuer,
    sub,
    aud: g.resource,
    client_id: g.client.id,
    scope,
    iat,
    exp,
    jti: randomBase64Url(16),
    ...(g.dpop !== null ? { cnf: { jkt: g.dpop.jkt } } : {}),
  });
  const answer: TokenAnswer = {
    access_token: access,
    token_type: g.dpop !== null ? "DPoP" : "Bearer",
    expires_in: exp - iat,
    scope,
  };
  // A refresh row only for a client of the refresh grant (review m1 of plan 12e).
  if (g.grantScopes.includes("offline_access") && refreshes) {
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
        config.observe.emit({
          name: "oauth.refresh_delete_failed",
          rowId: fresh.id,
          errorClass: e,
        });
      }
      return oauthFail("invalid_grant");
    }
    answer.refresh_token = fresh.token;
  }
  // OIDC Core 1.0 section 3.1.3.3: an ID token at the code exchange and the device poll. A refresh answers none.
  if (g.spentId === null && g.scopes.includes("openid")) {
    // Before the ID token: once the client holds its sid, a logout of the session reaches it (Task 16).
    // The link stores the sid, and a second ID token of the pair carries the stored one (ruling 57).
    let sid = g.sessionId === null ? null : await sidFor(config, g.sessionId, g.client);
    if (g.sessionId !== null && sid !== null && g.client.backchannelLogoutUri !== null)
      sid = await linkIdToken(config, {
        sessionId: g.sessionId,
        clientId: g.client.id,
        userId: g.user.id,
        sid,
      });
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub,
      aud: g.client.id,
      iat,
      exp,
      at_hash: await tokenHashClaim(alg, access),
      ...(sid !== null ? { sid } : {}),
      ...(g.nonce !== null ? { nonce: g.nonce } : {}),
      // OIDC Core 1.0 section 2: the time of the sign-in, not of the request.
      ...(g.authTime !== null ? { auth_time: g.authTime } : {}),
    };
    Object.assign(claims, scopeClaims(g.user, g.scopes));
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
 * a reused code). Two parallel exchanges can race. The loser's revoke
 * writes the end mark of the family. The winner reads it after its write
 * (`revokeFamily`), so the family ends in each order.
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
    /** The key of the request's DPoP proof, or null (plan 12e). */
    dpop: DpopBinding | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  const { client } = input.client;
  // RFC 6749 section 5.2: a client without the grant spends no code (review m1 of plan 12e).
  if (!client.grantTypes.includes("authorization_code")) return oauthFail("unauthorized_client");
  if (!CODE_RE.test(input.code)) return oauthFail("invalid_grant");
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
  // RFC 9449 section 10: a code of `dpop_jkt` needs a proof of that key.
  if (data.dpopJkt !== null && input.dpop?.jkt !== data.dpopJkt)
    return oauthFail("invalid_dpop_proof");
  const askedResource = namedResource(input.resource);
  if (askedResource !== null && askedResource !== data.resource) return oauthFail("invalid_target");
  // The code row's time: a code that an authorize wrote beside the ban gives nothing (ruling 29).
  const user = await liveUser(config, data.userId, consumed.value.createdAt);
  if (!user) return oauthFail("invalid_grant");
  // Every code comes from a consent that covers its scopes. A grant revoke
  // after the authorize step deletes the consent, and the code gives nothing.
  if (!(await consentCovers(config, user.id, client.id, data.scopes)))
    return oauthFail("invalid_grant");
  return issueTokens(config, {
    user,
    client,
    scopes: data.scopes,
    grantScopes: data.scopes,
    resource: data.resource,
    nonce: data.nonce,
    sessionId: data.sessionId,
    authTime: data.authTime,
    familyId: consumed.value.id,
    spentId: null,
    deviceId: null,
    dpop: input.dpop,
    bindRefresh: !input.client.confidential,
  });
}

/**
 * The tokens of a spent device row (plan 12e, RFC 8628 section 3.5): the
 * answer of the code exchange, with an ID token for `openid`. The family id
 * is the id of the device row. `pollDevice` checked the client, the key,
 * and the user, and spent the row.
 */
export async function issueDeviceTokens(
  config: ResolvedConfig,
  input: {
    row: OAuthDeviceRow;
    user: UserRow;
    client: AuthedClient;
    /** `authTimeOf` the session of the approval, or null when it ended. */
    authTime: number | null;
    dpop: DpopBinding | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  const { row } = input;
  return issueTokens(config, {
    user: input.user,
    client: input.client.client,
    scopes: row.scopes,
    grantScopes: row.scopes,
    resource: row.resource,
    nonce: null,
    sessionId: row.sessionId,
    authTime: input.authTime,
    familyId: row.id,
    spentId: null,
    deviceId: row.id,
    dpop: input.dpop,
    bindRefresh: !input.client.confidential,
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
 * True while `usedAt` is less than `oauth.refreshReuseSeconds` ago. With
 * the window at 0 (the default) this is never true. The odds are on the
 * config key `refreshReuseSeconds`.
 */
function inReuseWindow(config: ResolvedConfig, usedAt: Date, now: Date): boolean {
  return now.getTime() - usedAt.getTime() < oauthOf(config).refreshReuseSeconds * 1000;
}

/**
 * The spend of a retry inside the reuse window (plan 12e Task 13). It
 * spends the one unspent child of `parent` by one conditional update on
 * its `usedAt`, and answers the count of rows spent. Zero means the client
 * already used the child, or a parallel request spent it first: a reuse.
 * Each retry spends the live child, so two parallel retries leave one live
 * branch at most. Both can answer 200 when the second finds the new child
 * of the first. A row of a core before Task 13 has no `parentId`, so its
 * retry finds no child.
 */
async function spendChild(config: ResolvedConfig, parent: OAuthTokenRow, now: Date) {
  const child = await config.storage.findOne("oauthToken", [
    { field: "parentId", op: "eq", value: parent.id },
    { field: "usedAt", op: "eq", value: null },
  ]);
  if (!child) return 0;
  return config.storage.update(
    "oauthToken",
    [
      { field: "id", op: "eq", value: child.id },
      { field: "usedAt", op: "eq", value: null },
    ],
    { usedAt: now, updatedAt: now },
  );
}

/**
 * `grant_type=refresh_token`. Every check that can refuse runs before the
 * spend, so a refused request leaves the token usable. The spend is one
 * conditional update on `usedAt`; zero rows means a parallel request spent
 * it first, which is a reuse too. Two parallel refreshes race: the loser
 * ends the family while the winner writes its new row. So the winner reads
 * the end mark and its spent row after the write. When the mark is there or
 * the row is gone, the winner deletes its new row and answers
 * `invalid_grant`. In each order the family ends with no live row
 * (`revokeFamily`).
 *
 * A spent row inside the reuse window is a retry of its own client, after
 * the client auth and the DPoP check. The retry spends the child of the
 * first use and answers a new child of the spent row. So the family keeps
 * one live branch, and the superseded child, presented later, is a reuse.
 */
export async function refreshGrant(
  config: ResolvedConfig,
  input: {
    refreshToken: string;
    /** The client of the request, which `authenticateClient` checked (plan 12e). */
    client: AuthedClient;
    scope: string | null;
    resource: string | null;
    /** The key of the request's DPoP proof, or null (plan 12e). */
    dpop: DpopBinding | null;
  },
): Promise<OAuthResult<TokenAnswer>> {
  const client = input.client.client;
  // RFC 6749 section 5.2: a client without the grant spends no token (review m1 of plan 12e).
  if (!client.grantTypes.includes("refresh_token")) return oauthFail("unauthorized_client");
  const row = await refreshRowOf(config, input.refreshToken);
  if (!row || row.clientId !== client.id) return oauthFail("invalid_grant");
  // RFC 9449 section 5: a bound token needs a proof of its key. This runs
  // before the reuse check: a copy without the key cannot end the family.
  if (row.dpopJkt !== null && input.dpop?.jkt !== row.dpopJkt)
    return oauthFail("invalid_dpop_proof");
  const now = config.clock.now();
  if (row.usedAt !== null && !inReuseWindow(config, row.usedAt, now)) return reuse(config, row);
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
  const askedResource = namedResource(input.resource);
  if (askedResource !== null && askedResource !== row.resource) return oauthFail("invalid_target");
  // The auth read the client: a CIMD document that did not answer refused this refresh there, and the family stays.
  const user = await liveUser(config, row.userId);
  if (!user || (await familyRevoked(config, user, row))) return reuse(config, row);
  const spent =
    row.usedAt !== null
      ? await spendChild(config, row, now)
      : await config.storage.update(
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
    // The same client as the row's: the check at the start compared the ids.
    client,
    scopes,
    grantScopes: row.scopes,
    resource: row.resource,
    nonce: null,
    sessionId: null,
    authTime: null,
    familyId: row.familyId,
    spentId: row.id,
    deviceId: null,
    dpop: input.dpop,
    bindRefresh: !input.client.confidential,
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
    config.observe.emit({
      name: "oauth.revoke",
      clientRef: await clientRef(row.clientId),
      outcome: "success",
    });
  }
  return oauthOk({ revoked: true });
}

/** A valid access token: of a user (`oauth`), or of a client that acts for no user (`oauth-client`, plan 12e). */
export type ResolvedAccess =
  /** `subject`: the token's `sub`, a pairwise subject for a pairwise client (plan 12e). */
  | { kind: "oauth"; access: OAuthAccess; subject: string }
  | { kind: "oauth-client"; access: OAuthClientAccess };

/**
 * The caller of an access token, or null. The token is a JWT that verifies
 * under a key of this instance, with `typ: "at+jwt"` and this issuer. It
 * has an `aud` in `oauth.resources`, a live `exp`, and a number `iat`. Then
 * a user that exists, with no ban window over `iat`, and each scope still
 * in `oauth.scopes`. For a `client_credentials` token, a client
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
  // The ban window reads the issue time (ruling 28). Core writes iat in each access token.
  if (typeof p.iat !== "number") return null;
  if (
    typeof p.sub !== "string" ||
    typeof p.client_id !== "string" ||
    typeof p.scope !== "string" ||
    typeof p.jti !== "string"
  )
    return null;
  // RFC 9449 section 6.1: a bound token names the thumbprint of its key.
  const dpopJkt = cnfJkt(p.cnf);
  if (dpopJkt === undefined) return null;
  const scopes = p.scope.split(" ").filter((s) => s.length > 0);
  // Core makes a user id as a ULID and a client id as a `cl_` token or an https URL, so core's ids never collide.
  // A compat app can bring its own user ids, and one can equal a client id: the compat docs name that case (ruling 27).
  if (p.sub === p.client_id) {
    const access = await clientAccessOf(config, {
      clientId: p.client_id,
      scopes,
      resource: p.aud,
      jti: p.jti,
      exp: p.exp,
      dpopJkt,
    });
    return access ? { kind: "oauth-client", access } : null;
  }
  // Each scope must still be a scope of this config, as for a client token (ruling 29 of plan 12e).
  if (!scopes.every((s) => oauth.scopes.has(s))) return null;
  // The map back of a pairwise sub needs the client's sector (plan 12e Task 11).
  const client = await config.storage.findOne("oauthClient", [
    { field: "id", op: "eq", value: p.client_id },
  ]);
  if (!client) return null;
  const userId = await userOfSubject(config, p.sub, client);
  if (userId === null) return null;
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  // A token from before the end of the user's last ban answers as no token
  // here (rulings 5, 25, and 28 of plan 12f). This holds also after the
  // unban or the end. A resource server that verifies the JWT alone accepts
  // it to its exp.
  if (!user || bannedFor(user, new Date(p.iat * 1000))) return null;
  return {
    kind: "oauth",
    subject: p.sub,
    access: {
      user,
      clientId: p.client_id,
      scopes,
      resource: p.aud,
      tokenId: p.jti,
      expiresAt: new Date(p.exp * 1000),
      dpopJkt,
    },
  };
}

/** The `jkt` of a `cnf` claim: null with no claim, undefined for a claim of another shape. */
function cnfJkt(cnf: unknown): string | null | undefined {
  if (cnf === undefined) return null;
  if (typeof cnf !== "object" || cnf === null) return undefined;
  const jkt = (cnf as Record<string, unknown>).jkt;
  return typeof jkt === "string" ? jkt : undefined;
}

/**
 * The user claims of each scope (OIDC Core 1.0 section 5.4). The ID token,
 * userinfo, and `claims_supported` of the metadata read this one map.
 */
export const SCOPE_CLAIMS: Readonly<
  Record<string, Readonly<Record<string, (u: UserRow) => unknown>>>
> = {
  email: { email: (u) => u.email, email_verified: (u) => u.emailVerified },
  profile: { name: (u) => u.name, picture: (u) => u.image },
};

/** The claims of an ID token beside the user claims (OIDC Core 1.0 sections 2 and 3.1.3.6). */
export const ID_TOKEN_CLAIMS: readonly string[] = [
  "iss",
  "sub",
  "aud",
  "iat",
  "exp",
  "at_hash",
  "sid",
  "nonce",
  "auth_time",
];

/** The user claims of `scopes`, by `SCOPE_CLAIMS`. */
function scopeClaims(user: UserRow, scopes: readonly string[]): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const scope of scopes) {
    // An own key only: a scope such as "constructor" names no claims.
    const named = Object.hasOwn(SCOPE_CLAIMS, scope) ? SCOPE_CLAIMS[scope] : undefined;
    for (const [name, value] of Object.entries(named ?? {})) claims[name] = value(user);
  }
  return claims;
}

/**
 * The userinfo claims by scope (OIDC Core 1.0 section 5.3), or null without
 * `openid`. `subject` is the token's `sub`: the user id, or a pairwise subject.
 */
export function userinfoClaims(
  access: OAuthAccess,
  subject: string,
): Record<string, unknown> | null {
  if (!access.scopes.includes("openid")) return null;
  return { sub: subject, ...scopeClaims(access.user, access.scopes) };
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
