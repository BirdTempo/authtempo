import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { SESSION_JWT_TYPE } from "../primitives/credentials.js";
import type { SessionRow } from "../schema.js";
import { issuerOf, mintConfig, verifyLocal } from "./jwt.js";
import { findClient } from "./oauth-clients.js";
import { userOfSubject } from "./oauth-subject.js";
import { sessionsEnded } from "./sessions.js";

/**
 * The end-session route of one IP: 60 per 15 minutes (plan 12e). Each
 * request can verify a hint and read a client. A browser asks it once per
 * sign-out, so 60 leaves room for a shared NAT.
 */
export const END_SESSION_PER_IP = { seconds: 900, max: 60 };

/** True when the IP is past `END_SESSION_PER_IP` at the end-session route. */
export const endSessionLimited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-end-session:ip:${ipKey(ip)}`, END_SESSION_PER_IP));

/**
 * What a valid `id_token_hint` names. `clientId` is its `aud`. `sid` is the
 * session of the sign-in, or null when the code had no session. `sub` is the
 * user id: a pairwise subject is mapped back to its user.
 */
export interface IdTokenHint {
  clientId: string;
  sid: string | null;
  sub: string;
}

/**
 * The claims of an ID token that this instance signed, or null. The
 * signature verifies under the signing key or a key retired less than 24
 * hours ago. The header `typ` is `JWT`, `iss` is this issuer, and `aud` is
 * one string that names a client. An `aud` of `jwtMint.audience` is
 * refused: a session JWT has the same `typ`, but it is not an ID token.
 * `exp` is not checked: RP-Initiated Logout 1.0 section 2 accepts an
 * expired hint for its `sub` and `aud`.
 */
export async function checkIdTokenHint(
  config: ResolvedConfig,
  hint: string,
): Promise<IdTokenHint | null> {
  const decoded = await verifyLocal(config, hint);
  if (!decoded || decoded.header.typ !== SESSION_JWT_TYPE) return null;
  const p = decoded.payload;
  if (p.iss !== issuerOf(config) || typeof p.sub !== "string") return null;
  if (typeof p.aud !== "string" || mintConfig(config).audience.includes(p.aud)) return null;
  if (p.sid !== undefined && typeof p.sid !== "string") return null;
  const client = await findClient(config, p.aud);
  if (!client) return null;
  const userId = await userOfSubject(config, p.sub, client);
  if (userId === null) return null;
  return { clientId: client.id, sid: p.sid ?? null, sub: userId };
}

/**
 * Ends one session by its id for a relying party (RP-Initiated Logout 1.0).
 * The delete is by id, so the row that `session.afterEnd` names is the row
 * that this call deleted. A parallel end of the same row fires once. True
 * when this call ended the session.
 */
export async function endSession(
  config: ResolvedConfig,
  input: { session: SessionRow },
): Promise<boolean> {
  const n = await config.storage.delete("session", [
    { field: "id", op: "eq", value: input.session.id },
  ]);
  if (n !== 1) return false;
  await sessionsEnded(config, [input.session], "oidc_logout");
  return true;
}

/**
 * The URL that a logout redirects to, or null. Only a valid hint gives one,
 * and only to an exact entry of the client's `postLogoutRedirectUris`
 * (RP-Initiated Logout 1.0 section 3). `state` goes back only here.
 */
export async function logoutRedirect(
  config: ResolvedConfig,
  input: { hint: IdTokenHint | null; uri: string | null; state: string | null },
): Promise<string | null> {
  if (input.hint === null || input.uri === null) return null;
  const client = await findClient(config, input.hint.clientId);
  if (!client?.postLogoutRedirectUris.includes(input.uri)) return null;
  if (input.state === null) return input.uri;
  const url = new URL(input.uri);
  url.searchParams.append("state", input.state);
  return url.toString();
}
