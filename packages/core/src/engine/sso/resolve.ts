import type { ResolvedConfig } from "../../config.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import type { MemberRow, SsoConnectionRow, SsoMfaList, UserRow } from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { type CreateSteps, createSteps, verifySteps } from "../create-steps.js";
import { hookGuard, runAfter, runBefore, stopWith } from "../hooks.js";
import { addMemberIn, publicOrganization } from "../organizations.js";
import { effectiveIn } from "../permissions.js";
import { gatedSteps, type SignInChallenge, touchTrust } from "../second-factor.js";
import { endedList, sessionOpened, sessionsEnded } from "../sessions.js";
import { resolveSocialUser } from "../social.js";
import { normalizeEmail } from "../users.js";
import { publicConnection, type SsoConnectionSummary } from "./connections.js";
import { inOrganizationDomains } from "./domains.js";

/**
 * The person that an IdP names after its checks (plan 12d Task 5). The OIDC
 * callback and the SAML ACS make it. It holds no `email_verified`: no word
 * of the IdP proves an address, only a verified domain of the organization.
 */
export interface SsoProfile {
  /** The IdP's id of the person: 1 to 255 characters, no control character. */
  subject: string;
  /** The address as the IdP gives it, or null. The resolution normalizes it. */
  email: string | null;
  name: string | null;
  image: string | null;
  /** The OIDC `amr` values, or `[]`. */
  amr: readonly string[];
  /** The OIDC `acr` value, or null. */
  acr: string | null;
  /** The SAML `AuthnContextClassRef`, or null. Null for OIDC. */
  authnContext: string | null;
  /** SAML SessionNotOnOrAfter; caps the session's expiresAt. Null for OIDC. */
  sessionNotOnOrAfter: Date | null;
}

/** The answer of a sign-in that opens a session: the answer of `completeSocial`. */
export interface SsoSignedIn {
  token: string;
  next: string;
  user: UserRow;
}

/** The request facts that the resolution passes to the session and the gate. */
export interface SsoResolveInput {
  next: string;
  ip: string | null;
  userAgent: string | null;
  trustDevice?: string | undefined;
}

/** The key of the connection's `mfa` list that the profile matches, or null. */
function passedKey(mfa: SsoMfaList | null, profile: SsoProfile): keyof SsoMfaList | null {
  if (mfa === null) return null;
  if (mfa.amr?.some((v) => profile.amr.includes(v))) return "amr";
  if (profile.acr !== null && mfa.acr?.includes(profile.acr)) return "acr";
  if (profile.authnContext !== null && mfa.authnContext?.includes(profile.authnContext))
    return "authnContext";
  return null;
}

/**
 * True when the IdP did the second factor by the connection's list (spec 30
 * item 13). One of three facts holds, by exact string compare.
 * `profile.amr` holds one value of `mfa.amr`. Or `profile.acr` equals one
 * value of `mfa.acr`. Or `profile.authnContext` equals one value of
 * `mfa.authnContext`. A connection with no list passes nothing, so a user
 * with the factor on never signs in without it.
 */
export function idpPassedMfa(mfa: SsoMfaList | null, profile: SsoProfile): boolean {
  return passedKey(mfa, profile) !== null;
}

/**
 * The member row of the connection's organization (Behavior 6), in the
 * resolution's transaction. A row that exists stays as it is, and the
 * answer is null. Else `addMemberIn` adds a row with the connection's
 * `defaultRole`, under the member limits and the lock order of
 * user-hold.ts. A role that the organization no longer has answers
 * `role_not_found` (ruling 25 N2), and the throw undoes the sign-in.
 */
async function joinOrganization(
  config: ResolvedConfig,
  tx: StorageAdapter,
  connection: SsoConnectionRow,
  user: UserRow,
  now: Date,
): Promise<MemberRow | null> {
  const o = config.organizations;
  if (!o) stopWith("sso_not_configured");
  // A member needs a verified address, as `addMember` does. An SSO identity
  // comes with a proof of the address, so its user is verified.
  if (!user.emailVerified) return null;
  const organizationId = connection.organizationId;
  const held = await tx.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: user.id },
  ]);
  if (held) return null;
  const organization = await tx.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) stopWith("sso_not_configured");
  // A dynamic role can go after the connection names it: a delete of the role does not read the connections.
  if ((await effectiveIn(config, tx, organizationId, connection.defaultRole)).unnamed > 0)
    stopWith("role_not_found");
  const member: MemberRow = {
    id: newId(now),
    organizationId,
    userId: user.id,
    role: connection.defaultRole,
    createdAt: now,
    updatedAt: now,
  };
  const added = await addMemberIn(config, tx, o, {
    organization,
    member,
    user,
    by: null,
    via: "sso",
  });
  if (added.ok) return member;
  // A parallel sign-in added the row after the read: it stays as it is.
  if (added.code === "already_member") return null;
  stopWith(added.code === "not_found" ? "sso_not_configured" : added.code);
}

/**
 * The steps before the resolution's first write. A user that SCIM
 * deactivated in this organization answers `account_disabled` (Behavior 7).
 * Then `hooks.sso.beforeSignIn` (Behavior 2), with the user, or null for a
 * create. No lock comes before them, so a throw leaves nothing.
 */
async function beforeSignIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  event: { connection: SsoConnectionSummary; profile: SsoProfile },
  user: UserRow,
  created: boolean,
): Promise<void> {
  if (!created) {
    const row = await tx.findOne("scimUser", [
      { field: "organizationId", op: "eq", value: event.connection.organizationId },
      { field: "userId", op: "eq", value: user.id },
    ]);
    if (row && !row.active) stopWith("account_disabled");
  }
  await runBefore("sso.beforeSignIn", config.hooks.sso.beforeSignIn, {
    ...event,
    user: created ? null : user,
  });
}

/**
 * The resolution of an SSO sign-in (plan 12d Task 5, spec 30 item 11). It
 * has the shape of the social resolution. One transaction runs through
 * `resolveSocialUser`, with the provider `sso:<connectionId>`.
 *
 * 1. The address must be in a verified domain of the connection's
 *    organization, else `sso_domain_mismatch`, before any write.
 * 2. `hooks.sso.beforeSignIn` runs before the first write.
 * 3. A known identity signs in its user.
 * 4. A user at the address gets the identity; an unverified one is claimed.
 * 5. No user: a just-in-time create under the sign-up rule, or
 *    `sso_not_provisioned` with `jit` off.
 * 6. The member row of the organization, with the connection's role.
 * 7. A user that SCIM deactivated answers `account_disabled`.
 * 8. The gate of section 8.14, unless the IdP did the second factor by the
 *    connection's `mfa` list.
 * 9. The session opens with `via: "sso"`. `sessionNotOnOrAfter` caps it.
 */
export async function resolveSsoUser(
  config: ResolvedConfig,
  connection: SsoConnectionRow,
  profile: SsoProfile,
  input: SsoResolveInput,
): Promise<Result<SsoSignedIn | SignInChallenge>> {
  const email = profile.email === null ? null : normalizeEmail(profile.email);
  if (email === null) return refused(connection, "email_required", input.ip);
  // An IdP that an organization owner configured is that owner's word. The
  // owner's DNS proof makes the word true for an address in the domain
  // (spec 30 item 11). So the IdP's email_verified is never read.
  if (!(await inOrganizationDomains(config.storage, connection.organizationId, email)))
    return refused(connection, "sso_domain_mismatch", input.ip);
  const now = config.clock.now();
  const { next } = input;
  const ended = endedList(config);
  const gateOn = config.totp?.gate.sso ?? false;
  const gate = gatedSteps(
    config,
    {
      ip: input.ip,
      userAgent: input.userAgent,
      via: "sso",
      next,
      trustDevice: input.trustDevice,
      gate: gateOn && !idpPassedMfa(connection.mfa, profile),
      notAfter: profile.sessionNotOnOrAfter ?? undefined,
    },
    now,
  );
  const made = createSteps(config, "sso", { signUpRule: true });
  const steps: CreateSteps = {
    ...made,
    async user(tx, user) {
      // Behavior 5: with jit off, the sign-in creates no user and writes nothing.
      if (!connection.jit) stopWith("sso_not_provisioned");
      return made.user(tx, user);
    },
  };
  const verified = verifySteps(config, "sso");
  const summary = publicConnection(config, connection);
  let joined: MemberRow | null = null;
  const resolved = await hookGuard(() =>
    resolveSocialUser(
      config.storage,
      `sso:${connection.id}`,
      // The domain proof is the proof of the address (Behavior 1).
      { ...profile, email, emailVerified: true },
      now,
      verified,
      async (tx, user) => {
        joined = await joinOrganization(config, tx, connection, user, now);
        return gate.write(tx);
      },
      ended,
      async (tx, user, created) => {
        await beforeSignIn(config, tx, { connection: summary, profile }, user, created);
        await gate.before(tx, user);
      },
      steps,
    ),
  );
  if (!resolved.ok) return refused(connection, resolved.code, input.ip, resolved);
  const { user, after } = resolved.value;
  // After the commit, before the session hook and before a challenge answer (plan 12a).
  await verified.after(user);
  await made.after(user);
  await sessionsEnded(config, ended, "claim", verified.stops);
  const member = joined as MemberRow | null;
  if (member) {
    const organization = await config.storage.findOne("organization", [
      { field: "id", op: "eq", value: member.organizationId },
    ]);
    if (organization)
      await runAfter(
        "organization.afterAddMember",
        config.hooks.organization.afterAddMember,
        {
          organization: publicOrganization(organization),
          member: {
            id: member.id,
            userId: user.id,
            role: member.role,
            email: user.email,
            name: user.name,
            createdAt: member.createdAt,
          },
          memberUser: user,
          by: null,
          via: "sso",
          invitation: null,
        },
        member.id,
      );
  }
  if (after.kind === "challenge") return ok({ ...after.pending, next, user });
  await touchTrust(config, gate.trustId(), now);
  const key = gateOn ? passedKey(connection.mfa, profile) : null;
  // The pass of the second factor by the IdP (spec 30 item 13): the key name, and no new field.
  if (key !== null) console.info("authtempo: sso second factor by the idp", connection.id, key);
  await sessionOpened(config, after.session, user, "sso");
  return ok({ token: after.token, next, user });
}

/**
 * One log line of a refused resolution: the connection id, the code, and
 * the IP (Global Constraints of plan 12d). `result` keeps the hook text of
 * a refusal.
 */
function refused(
  connection: SsoConnectionRow,
  code: Exclude<Result<never>, { ok: true }>["code"],
  ip: string | null,
  result?: Result<never>,
): Result<never> {
  console.error("authtempo: sso refused", connection.id, code, ip);
  return result ?? fail(code);
}
