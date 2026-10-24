import type { PasskeySummaryJSON } from "@authtempo/client";
import {
  DEFAULT_SESSION_COOKIE,
  type InvitationSummary,
  LEGACY_SESSION_COOKIE,
  type MemberSummary,
  type OrganizationSummary,
  readSessionToken,
  type SessionRow,
  type SessionSummary,
  type TeamMemberSummary,
  type TeamSummary,
  type UserRow,
} from "@authtempo/core";
import type {
  Invitation,
  Member,
  Organization,
  Passkey,
  Session,
  Team,
  TeamMember,
  User,
} from "../types.js";

// Each converter builds an object literal under the declared return type, so
// a field added to the type and not filled here fails the compile, and an
// extra field fails it too (Review Focus 4). The key lists below feed the
// runtime check in test/better-auth.test.ts.

/**
 * The address that Better Auth's shapes show for a user with no address
 * (plan 12i). Better Auth's own default form is `<id>@<namespace>.placeholder.invalid`
 * (`createPlaceholderEmail` of @better-auth/core 1.7.2, deviation 7), and
 * `.invalid` never resolves (RFC 6761 section 6.4). The storage of the
 * Better Auth tables writes the same form for a null address, or
 * `temp-<id>@<emailDomainName>` with that option (placeholder.ts, plan 12i
 * Task 16). It reads each back as null.
 */
export function shownAddress(user: { id: string; email: string | null }): string {
  return user.email ?? `${user.id}@anonymous.placeholder.invalid`;
}

export function toUser(u: UserRow): User {
  return {
    id: u.id,
    name: u.name ?? "",
    email: shownAddress(u),
    emailVerified: u.emailVerified,
    image: u.image,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function toSession(s: SessionRow, token: string): Session {
  return {
    id: s.id,
    token,
    userId: s.userId,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ipAddress: s.ip,
    userAgent: s.userAgent,
    activeOrganizationId: s.activeOrganizationId,
    activeTeamId: s.activeTeamId,
  };
}

/**
 * Better Auth's session of one entry of core's session list (plan 12a).
 * Better Auth answers the clear token in `token`. The shim holds only its
 * hash, so the id stands in.
 */
export function listedSession(s: SessionSummary, userId: string): Session {
  return {
    id: s.id,
    token: s.id,
    userId,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    updatedAt: s.lastSeenAt,
    ipAddress: s.ip,
    userAgent: s.userAgent,
    activeOrganizationId: s.activeOrganizationId,
    activeTeamId: s.activeTeamId,
  };
}

/**
 * Better Auth 1.7.2's passkey row (@better-auth/passkey dist/index.mjs:669 to
 * :716, read 2026-10-17), as far as core answers it: core keeps the public
 * key, the counter, the transports, and the AAGUID out of its answers. The
 * date stays the text of core's JSON.
 */
export function toPasskey(p: PasskeySummaryJSON, userId: string): Passkey {
  return {
    id: p.id,
    name: p.name,
    userId,
    credentialID: p.credentialId,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    createdAt: p.createdAt,
  };
}

export function toOrganization(o: OrganizationSummary): Organization {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    logo: null,
    metadata: o.metadata,
    createdAt: o.createdAt,
  };
}

export function toMember(organizationId: string, m: MemberSummary): Member {
  return {
    id: m.id,
    organizationId,
    userId: m.userId,
    role: m.role,
    createdAt: m.createdAt,
    user: {
      id: m.userId,
      email: shownAddress({ id: m.userId, email: m.email }),
      name: m.name ?? "",
    },
  };
}

export function toInvitation(
  i: InvitationSummary,
  id: string,
  status: Invitation["status"],
): Invitation {
  return {
    id,
    organizationId: i.organizationId,
    email: i.email,
    role: i.role,
    status,
    inviterId: i.inviterId,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
  };
}

/** Better Auth's team (plan 12k Task 11). */
export function toTeam(t: TeamSummary): Team {
  return {
    id: t.id,
    name: t.name,
    organizationId: t.organizationId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Better Auth's team member (plan 12k Task 11). */
export function toTeamMember(m: TeamMemberSummary): TeamMember {
  return { id: m.id, teamId: m.teamId, userId: m.userId, createdAt: m.createdAt };
}

type Exact<T, K extends readonly (keyof T)[]> = [Exclude<keyof T, K[number]>] extends [never]
  ? K
  : never;
const keys =
  <T>() =>
  <const K extends readonly (keyof T)[]>(k: Exact<T, K>) =>
    k;
export const USER_KEYS = keys<User>()([
  "id",
  "name",
  "email",
  "emailVerified",
  "image",
  "createdAt",
  "updatedAt",
]);
export const SESSION_KEYS = keys<Session>()([
  "id",
  "token",
  "userId",
  "expiresAt",
  "createdAt",
  "updatedAt",
  "ipAddress",
  "userAgent",
  "activeOrganizationId",
  "activeTeamId",
]);

/**
 * The session cookie name. The one copy in this package: `mapOptions` passes
 * it to core as `cookieName`, and the reader below, the bearer copy, and the
 * client read it here. Since plan 12b the name is core's default, so core's
 * router moves the old `tempo_session` for one release, and `readToken`
 * reads it too. The Expo storage key keeps the old name (create-auth-client.ts).
 */
export const COOKIE_NAME = DEFAULT_SESSION_COOKIE;

/** The non-empty session token a response sets, or null. */
export function sessionTokenOf(cookies: string[]): string | null {
  const prefix = `${COOKIE_NAME}=`;
  for (const c of cookies) {
    if (!c.startsWith(prefix)) continue;
    const value = c.slice(prefix.length).split(";")[0];
    if (value) return value;
  }
  return null;
}

/**
 * The cookie or the bearer header, read by core's own `readSessionToken`
 * with this package's cookie name. Only the session token for Better Auth's
 * `session.token` comes from here; core's `auth.session(request)` decides
 * who the caller is.
 */
export function readToken(headers: Headers): string | null {
  return readSessionToken(
    { cookieName: COOKIE_NAME, legacyCookieName: LEGACY_SESSION_COOKIE },
    { headers },
  );
}

/**
 * Better Auth's callbackURL or redirectTo to core's `next`. Core takes a
 * path only and lands every sign-in on one origin, appURL (core
 * http/redirect.ts). A path stays as given. An absolute URL on `appOrigin`
 * becomes its path, query, and fragment, so the browser lands where the app
 * asked. Any other value answers null, and the caller refuses it with
 * Better Auth's own code (`INVALID_CALLBACK_URL` or `INVALID_REDIRECT_URL`,
 * status 403, as Better Auth's origin check answers). A trusted origin that
 * is not appURL is refused too: core would land on appURL with that path, so
 * the browser would not reach the origin the app asked for. `appOrigin` null
 * (a client with no `location`) refuses every absolute URL.
 */
export function toNext(
  callbackURL: string | undefined,
  appOrigin: string | null,
): string | undefined | null {
  if (callbackURL === undefined) return undefined;
  if (callbackURL.startsWith("/") && !callbackURL.startsWith("//")) return callbackURL;
  let u: URL;
  try {
    u = new URL(callbackURL);
  } catch {
    return null;
  }
  if (appOrigin === null || u.origin !== appOrigin) return null;
  return `${u.pathname}${u.search}${u.hash}`;
}

/**
 * The refusal of Better Auth's `additionalData` (plan 12i ruling 5). A Better
 * Auth app reads it with `getOAuthState()` in a database hook. The shim
 * serves no `getOAuthState()`, so a mapped payload would reach no app code.
 */
export const STATE_DATA_REFUSAL =
  "core takes no additionalData through the shim: use social.stateData of core's createAuth, and read stateData in its hooks.session.afterCreate and hooks.identity.afterLink";
