import type { ResolvedConfig } from "../config.js";
import { peekRequestSession } from "../engine/sessions.js";
import { ERRORS } from "../errors.js";
import { json } from "./json.js";
import type { RouteKey } from "./route-list.js";

/**
 * What an impersonation session can reach (plan 12f Task 11, spec 26 item
 * 9). An impersonation session acts as the user for support, so it reads
 * and changes what the user sees. It never gets a way in, a fresh session,
 * an operator act, or a grant that outlives it. Each route of `ROUTES` is
 * in exactly one of the two lists. `impersonation-rules.test.ts` holds them
 * to `ROUTES` both ways, so a new route fails the test until it gets a
 * class.
 */

/** The cookie that keeps the operator's own token during an impersonation: the session cookie name with `_actor` (plan 12f deviation 9). */
export function actorCookieName(config: Pick<ResolvedConfig, "cookieName">): string {
  return `${config.cookieName}_actor`;
}

/**
 * The routes that answer 403 `impersonation_session` to an impersonation
 * session, before the handler. Each entry declares the code.
 */
export const IMPERSONATION_REFUSED: ReadonlySet<RouteKey> = new Set<RouteKey>([
  // Every operator route but the stop: an impersonation session is no operator.
  "POST /operator/keys/rotate",
  "GET /operator/secrets/status",
  "POST /operator/secrets/rewrap",
  "GET /operator/info",
  "POST /operator/impersonate",
  "GET /operator/users",
  "GET /operator/users/search",
  "GET /operator/users/get",
  "POST /operator/users/ban",
  "POST /operator/users/unban",
  "POST /operator/users/platform-role",
  "POST /operator/users/second-factor/disable",
  "POST /operator/users/create-admin",
  "POST /operator/sessions/end-user",
  "POST /operator/sessions/end-all",
  "GET /operator/audit",
  "POST /operator/sso/enforce-off",
  // The SSO writes of plan 12d: an operator who acts as a user must not add
  // or change a domain proof. The guard refuses such a session too, for the
  // calls of api.sso (plan 12d deviation 4).
  "POST /sso/domains/add",
  "POST /sso/domains/verify",
  "POST /sso/domains/update",
  "POST /sso/domains/delete",
  // The connection writes of plan 12d Task 3: a connection adds an IdP that
  // outlives the impersonation.
  "POST /sso/connections/create",
  "POST /sso/connections/update",
  "POST /sso/connections/delete",
  // The SCIM token writes of plan 12d Task 9: a credential route, as POST
  // /organizations/tokens (12k ruling 7). A token outlives the impersonation.
  "POST /scim/tokens/create",
  "POST /scim/tokens/revoke",
  // The stop is the one way out. A sign-out would end the session with no
  // stop row and keep the actor cookie (ruling 6 for the end-session route).
  "POST /sign-out",
  // The re-authentication and its helpers: the session never becomes fresh,
  // so every change behind the fresh rule of plan 12a refuses.
  "POST /reauth",
  "POST /reauth/passkey/options",
  "POST /reauth/email",
  // The ways in, by name (ruling 7), so a later change of the fresh rule cannot open them.
  "POST /user/change-email",
  "POST /user/change-email/verify",
  "POST /user/delete",
  "POST /user/delete/confirm",
  "POST /identities/unlink",
  "POST /social/:provider/link",
  "POST /passkey/register/options",
  "POST /passkey/register/verify",
  "POST /passkeys/delete",
  "POST /password/change",
  // An API token outlives the impersonation.
  "POST /tokens",
  // Every route of the second-factor families of plans 9f and 12c, also
  // those that need no fresh session.
  "POST /totp/setup",
  "POST /totp/enable",
  "POST /totp/disable",
  "POST /totp/backup-codes",
  "GET /totp",
  "POST /totp/devices/revoke",
  "POST /totp/verify",
  "GET /totp/challenge",
  "POST /totp/challenge",
  "POST /second-factor/passkey/enable",
  "POST /second-factor/passkey/options",
  "POST /second-factor/disable",
  "POST /second-factor/email/enable",
  "POST /second-factor/email/send",
  // The handoff makes a code from the browser session, and the code
  // redeems to a session with no mark and no fixed expiry.
  "GET /handoff/start",
  "GET /handoff/continue",
  "POST /handoff/continue",
  // The organization writes that can need the owner rank: the delete, and
  // each write that gives or takes a role, so no owner moves.
  "POST /organizations/delete",
  "POST /organizations/members/add",
  "POST /organizations/members/role",
  "POST /organizations/members/remove",
  "POST /organizations/invite",
  // The role writes of plan 12k (ruling 5 of plan 12k): the rights of other
  // people outlive the impersonation. The fresh rule also refuses them.
  "POST /organizations/roles/create",
  "POST /organizations/roles/update",
  "POST /organizations/roles/delete",
  // The token writes of plan 12k: a credential route, as `POST /tokens` (ruling 7).
  "POST /tokens/update",
  "POST /organizations/tokens",
  "POST /organizations/tokens/update",
  "POST /organizations/tokens/revoke",
  // The OAuth authorize and consent (ruling 6): a grant outlives the impersonation.
  "GET /oauth/authorize",
  "POST /oauth/authorize",
  "GET /oauth/sign-in",
  "GET /oauth/device",
  "POST /oauth/device",
  "POST /oauth/grants/revoke",
  "GET /oauth/end-session",
  "POST /oauth/end-session",
]);

/** The credential is in the request, and the route reads no session. */
const NO_SESSION = "It takes no session.";
/** A read of what the user sees. */
const READ = "It reads what the user sees.";
/** Each change behind the fresh rule refuses: the session has no fresh time. */
const FRESH = "It needs a fresh session, and an impersonation session is never fresh.";
/** A route of the SCIM server: the credential is a SCIM token (plan 12d). */
const SCIM_TOKEN = "It takes a SCIM token, never a session.";
/** A team write gives or takes no role, and the user can undo it; only the owner writes are refused. */
const TEAM_WRITE = "It writes a team of the organization; it gives or takes no role.";

/** Every other route, with the reason that it serves an impersonation session. */
export const IMPERSONATION_ALLOWED: Readonly<Partial<Record<RouteKey, string>>> = {
  "GET /session": "It reads the session, and the answer holds actorId for the mark.",
  "POST /session/refresh": "The refresh does not move the fixed expiry.",
  "GET /sessions": READ,
  "POST /sessions/revoke": FRESH,
  "POST /sessions/revoke-others": FRESH,
  "POST /user/update": "It writes the name and the image, which the user sees; no way in changes.",
  "GET /user/change-email/confirm": NO_SESSION,
  "POST /user/change-email/confirm": NO_SESSION,
  "GET /user/delete/confirm": "It shows a page and writes nothing; its POST is refused.",
  "GET /identities": READ,
  "POST /magic-link/request": NO_SESSION,
  "GET /magic-link/verify": NO_SESSION,
  "POST /magic-link/verify": NO_SESSION,
  "GET /social/:provider/start": NO_SESSION,
  "GET /social/:provider/callback": "It takes the state of a start; the link start is refused.",
  "POST /social/apple/callback": "It takes the state of a start; the link start is refused.",
  "POST /passkey/authenticate/options": NO_SESSION,
  "POST /passkey/authenticate/verify": NO_SESSION,
  "GET /passkeys": READ,
  "POST /passkeys/rename": "A name of a passkey is no way in.",
  "POST /password/sign-up": NO_SESSION,
  "POST /password/sign-in": NO_SESSION,
  "GET /password/verify": NO_SESSION,
  "POST /password/verify": NO_SESSION,
  "POST /password/verify/resend": NO_SESSION,
  "POST /password/reset/request": NO_SESSION,
  "GET /password/reset": NO_SESSION,
  "POST /password/reset": NO_SESSION,
  "POST /otp/request": NO_SESSION,
  "POST /otp/verify": NO_SESSION,
  "POST /otp/reset/request": NO_SESSION,
  "POST /otp/reset": NO_SESSION,
  "POST /handoff/redeem":
    "It takes a code and its verifier; the start and the continue are refused.",
  "POST /organizations/create": "It makes an organization that the user owns; it moves no member.",
  "GET /organizations": READ,
  "POST /organizations/update": "It writes the fields of the organization; it moves no member.",
  "GET /organizations/members": READ,
  "GET /organizations/invitations": READ,
  "POST /organizations/invitations/revoke": "It ends an invitation; it gives no role.",
  "POST /organizations/invitations/accept":
    "It adds the user by an invitation to the user's address, as the user can.",
  "POST /organizations/invitations/decline": "It ends an invitation; it gives no role.",
  "POST /organizations/active": "It selects the active organization of this session only.",
  // The routes of plan 12k (ruling 5 of plan 12k).
  "POST /organizations/has-permission": READ,
  "GET /organizations/permissions": READ,
  "GET /organizations/roles": READ,
  "GET /organizations/roles/get": READ,
  "POST /organizations/check-slug": "It reads whether a slug is free; it writes no row.",
  "GET /organizations/teams": READ,
  "GET /organizations/teams/mine": READ,
  "GET /organizations/teams/members": READ,
  "POST /organizations/teams/create": TEAM_WRITE,
  "POST /organizations/teams/update": TEAM_WRITE,
  "POST /organizations/teams/delete": TEAM_WRITE,
  "POST /organizations/teams/members/add": TEAM_WRITE,
  "POST /organizations/teams/members/remove": TEAM_WRITE,
  "POST /organizations/teams/active": "It selects the active team of this session only.",
  "GET /organizations/tokens": READ,
  "GET /organizations/tokens/current": NO_SESSION,
  "GET /tokens": READ,
  "POST /tokens/revoke": "It ends an API token; it makes none.",
  "GET /tokens/current": NO_SESSION,
  "GET /jwks": NO_SESSION,
  "GET /token": "The JWT holds act, and its exp is no later than the session's.",
  "POST /token/live": NO_SESSION,
  "POST /operator/impersonate/stop":
    "The one way out: it ends the session, writes the stop row, and restores the operator's cookie.",
  "POST /oauth/register": NO_SESSION,
  "POST /oauth/token": NO_SESSION,
  "POST /oauth/revoke": NO_SESSION,
  "POST /oauth/introspect": NO_SESSION,
  "POST /oauth/device_authorization": NO_SESSION,
  "GET /oauth/userinfo": NO_SESSION,
  "POST /oauth/userinfo": NO_SESSION,
  "GET /oauth/grants": READ,
  "GET /.well-known/oauth-authorization-server": NO_SESSION,
  "GET /.well-known/openid-configuration": NO_SESSION,
  "GET /.well-known/webauthn": NO_SESSION,
  "GET /openapi.json": NO_SESSION,
  "GET /health": NO_SESSION,
  "GET /ready": NO_SESSION,
  // Plan 12d (ruling 25 N7): a read of the manager holds no secret. The TXT
  // value is public once published. The guard still refuses the session.
  "GET /sso/domains": READ,
  // The answer holds no client secret and no sealed value (plan 12d Task 3);
  // a certificate is public. The guard still refuses the session.
  "GET /sso/connections": READ,
  // The list holds a hint of each token, never the token or its hash (ruling 25 N7
  // of plan 12d). The guard still refuses the session.
  "GET /scim/tokens": READ,
  // The SSO sign-in of plan 12d Task 4, as the social sign-in.
  "POST /sso/discover": NO_SESSION,
  "GET /sso/:connectionId/start": NO_SESSION,
  "GET /sso/:connectionId/callback": "It takes the state of a start, as the social callback.",
  // The SAML service provider of plan 12d Task 8, as the OIDC sign-in.
  "POST /sso/:connectionId/acs": "It takes the request row of a start, as the OIDC callback.",
  "GET /sso/:connectionId/metadata": NO_SESSION,
  // The SCIM server of plan 12d Task 9. impersonationRefusal reads only a session.
  "GET /scim/v2/ServiceProviderConfig": SCIM_TOKEN,
  "GET /scim/v2/ResourceTypes": SCIM_TOKEN,
  "GET /scim/v2/ResourceTypes/:id": SCIM_TOKEN,
  "GET /scim/v2/Schemas": SCIM_TOKEN,
  "GET /scim/v2/Schemas/:id": SCIM_TOKEN,
  "GET /scim/v2/Users": SCIM_TOKEN,
  "POST /scim/v2/Users": SCIM_TOKEN,
  "GET /scim/v2/Users/:id": SCIM_TOKEN,
  "PUT /scim/v2/Users/:id": SCIM_TOKEN,
  "PATCH /scim/v2/Users/:id": SCIM_TOKEN,
  "DELETE /scim/v2/Users/:id": SCIM_TOKEN,
  "GET /scim/v2/Groups": SCIM_TOKEN,
  "POST /scim/v2/Groups": SCIM_TOKEN,
  "GET /scim/v2/Groups/:id": SCIM_TOKEN,
  "PUT /scim/v2/Groups/:id": SCIM_TOKEN,
  "PATCH /scim/v2/Groups/:id": SCIM_TOKEN,
  "DELETE /scim/v2/Groups/:id": SCIM_TOKEN,
  "POST /scim/v2/Bulk": SCIM_TOKEN,
  "GET /scim/v2/Me": SCIM_TOKEN,
  "POST /scim/v2/.search": SCIM_TOKEN,
  "POST /scim/v2/Users/.search": SCIM_TOKEN,
  "POST /scim/v2/Groups/.search": SCIM_TOKEN,
};

/**
 * The refusal step of the router (spec 26 item 9): after the route match
 * and before the handler. A route of `IMPERSONATION_REFUSED` answers 403
 * `impersonation_session` when the request's session (the cookie, or a
 * `ts_` bearer) is a live impersonation session. Other routes pay no read.
 * The read writes nothing: no refresh and no delete.
 */
export async function impersonationRefusal(
  config: ResolvedConfig,
  request: Request,
  key: RouteKey,
): Promise<Response | null> {
  if (!IMPERSONATION_REFUSED.has(key)) return null;
  // The handler's session read takes this row, so the route reads it once (ruling 78 of plan 12d).
  const row = await peekRequestSession(config, request);
  if (row === null || row.actorId === null) return null;
  return json({ error: "impersonation_session" }, ERRORS.impersonation_session);
}
