import type { ResolvedConfig, ResolvedOAuth } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { decodeJws } from "../primitives/jwk.js";
import { issuerOf } from "./jwt.js";
import type { AuthedClient } from "./oauth-client-auth.js";
import { type OAuthResult, oauthFail, oauthOf, oauthOk } from "./oauth-result.js";
import {
  liveUser,
  type OAuthAccess,
  refreshRowOf,
  resolveAccessToken,
  servedGrantScopes,
} from "./oauth-token.js";

/**
 * Token introspection (plan 12e, RFC 7662, read 2026-10-20). A resource
 * server asks whether a token is live now. The value of this endpoint: a
 * revoke ends a token here at once, where the offline check accepts it
 * until `exp` (plan 12e).
 *
 * Section 2.2: an inactive answer carries `active` alone, whatever the
 * reason. A token of another form, an unknown token, and a refresh token of
 * another client all answer the same `{ active: false }`.
 */

/**
 * The answer of RFC 7662 section 2.2. A DPoP-bound access token answers
 * `token_type: "DPoP"` and its `cnf` (RFC 9449 section 6.2). The resource
 * server checks the proof itself.
 */
export type IntrospectAnswer =
  | { active: false }
  | {
      active: true;
      scope: string;
      client_id: string;
      sub: string;
      aud: string;
      iss: string;
      exp: number;
      iat: number;
      jti: string;
      token_type: "Bearer" | "DPoP";
      cnf?: { jkt: string };
    };

// RFC 7662 section 4: a throttle against a scan of token values. A resource
// server asks once per request of its own callers, so the count is 10 a second.
export const INTROSPECT_PER_CLIENT = { seconds: 60, max: 600 };
// The route counts this before the client auth, so a failed auth counts too.
// It bounds the reads and the key fetches that failed auths cause from one IP.
export const INTROSPECT_PER_IP = { seconds: 60, max: 600 };

/** True when the IP is past `INTROSPECT_PER_IP` at the introspection route. */
export const introspectLimited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-introspect:ip:${ipKey(ip)}`, INTROSPECT_PER_IP));

type Active = Extract<IntrospectAnswer, { active: true }>;

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * True while the user's grant to the client stands for `scopes`. A grant
 * revoke, a user delete, and a client delete each delete the consent. A
 * consent newer than the token comes from a new grant after a revoke, so
 * the token of the old grant stays inactive.
 */
async function grantStands(config: ResolvedConfig, access: OAuthAccess, iat: number) {
  const consent = await config.storage.findOne("oauthConsent", [
    { field: "userId", op: "eq", value: access.user.id },
    { field: "clientId", op: "eq", value: access.clientId },
  ]);
  return (
    consent !== null &&
    access.scopes.every((s) => consent.scopes.includes(s)) &&
    seconds(consent.createdAt) <= iat
  );
}

/**
 * The answer for an access token of a resource in `visible`, or null.
 * `resolveAccessToken` checks the signature, the type, the issuer, the
 * audience, `exp`, and each scope against `oauth.scopes`. For a client
 * token it also checks the client, its grant, and its client scopes (Task 7).
 */
async function accessAnswer(
  config: ResolvedConfig,
  token: string,
  visible: readonly string[],
): Promise<Active | null> {
  const resolved = await resolveAccessToken(config, token);
  if (!resolved || !visible.includes(resolved.access.resource)) return null;
  // resolveAccessToken verified this token, so its claims are core's own.
  const iat = decodeJws(token)?.payload.iat;
  if (typeof iat !== "number") return null;
  const { access } = resolved;
  if (resolved.kind === "oauth" && !(await grantStands(config, resolved.access, iat))) return null;
  return {
    active: true,
    scope: access.scopes.join(" "),
    client_id: access.clientId,
    sub: resolved.kind === "oauth" ? resolved.access.user.id : access.clientId,
    aud: access.resource,
    iss: issuerOf(config),
    exp: seconds(access.expiresAt),
    iat,
    jti: access.tokenId,
    ...(access.dpopJkt !== null
      ? { token_type: "DPoP" as const, cnf: { jkt: access.dpopJkt } }
      : { token_type: "Bearer" as const }),
  };
}

/**
 * The answer for a refresh token, or null. Only its own client learns of
 * it. That client exists: `authenticateClient` read its row for this
 * request. The token is live while the refresh grant would take it: unspent,
 * before its expiry, and of a user that exists with a verified address. It
 * answers the served scopes of the grant, and no scope but `offline_access`
 * is inactive (ruling 30). No resource map applies (ruling 30).
 */
async function refreshAnswer(
  config: ResolvedConfig,
  caller: AuthedClient,
  token: string,
): Promise<Active | null> {
  const row = await refreshRowOf(config, token);
  if (!row || row.clientId !== caller.client.id) return null;
  if (row.usedAt !== null || row.expiresAt.getTime() <= config.clock.now().getTime()) return null;
  const served = servedGrantScopes(config, row.scopes);
  if (!served || !(await liveUser(config, row.userId))) return null;
  return {
    active: true,
    scope: served.join(" "),
    client_id: row.clientId,
    sub: row.userId,
    aud: row.resource,
    iss: issuerOf(config),
    exp: seconds(row.expiresAt),
    iat: seconds(row.createdAt),
    jti: row.id,
    // Only a public client's refresh row is bound (RFC 9449 section 5), and a
    // public client never introspects; an update cannot change the method.
    token_type: "Bearer",
  };
}

/**
 * The resources whose tokens a caller may see (RFC 7662 section 4, ruling
 * 29 of plan 12e). The map of `oauth.introspection` names them. With no
 * map, one configured resource is the set, and several give an empty set:
 * core cannot tell which resource server the caller is.
 */
export function visibleResources(oauth: ResolvedOAuth, clientId: string): readonly string[] {
  if (oauth.introspection) return oauth.introspection.get(clientId) ?? [];
  return oauth.resources.length === 1 ? oauth.resources : [];
}

/**
 * `POST /oauth/introspect` for a caller that `authenticateClient` checked.
 * Section 4: the caller is a confidential client that the operator allowed
 * (`introspect: true` of `api.oauth.clients`), else `invalid_client`. A
 * missing `token` is `invalid_request` (section 2.1). `hint` orders the two
 * lookups only: a token never fits both forms. An access token of a
 * resource outside `visibleResources` answers inactive. A refresh token
 * answers its own client only, so no resource map applies to it.
 */
export async function introspect(
  config: ResolvedConfig,
  input: { caller: AuthedClient; token: string | null; hint: string | null },
): Promise<OAuthResult<IntrospectAnswer>> {
  const { caller } = input;
  if (!caller.confidential || !caller.client.introspect) return oauthFail("invalid_client");
  const limit = `oauth-introspect:client:${caller.client.id}`;
  if (!(await config.limiter.allow(limit, INTROSPECT_PER_CLIENT))) return oauthFail("rate_limited");
  const token = input.token;
  if (token === null) return oauthFail("invalid_request");
  const visible = visibleResources(oauthOf(config), caller.client.id);
  const lookups = [
    () => accessAnswer(config, token, visible),
    () => refreshAnswer(config, caller, token),
  ];
  if (input.hint === "refresh_token") lookups.reverse();
  for (const lookup of lookups) {
    const answer = await lookup();
    if (answer) return oauthOk(answer);
  }
  return oauthOk({ active: false });
}
