import type { ResolvedConfig } from "../../config.js";
import { organizationChange } from "../../observe/events.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import type {
  MemberRow,
  OrganizationRow,
  SsoConnectionRow,
  SsoMfaList,
  UserRow,
} from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { type CreateSteps, createSteps, verifySteps } from "../create-steps.js";
import { hookGuard, runAfter, runBefore, stopWith } from "../hooks.js";
import { addMemberIn, atMemberLimit, holdsMember, publicOrganization } from "../organizations.js";
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

/** The member add that the checks of `joinChecks` passed: the after step writes it. */
interface Join {
  organization: OrganizationRow;
  member: MemberRow;
}

/**
 * The checks of the member row of the connection's organization (Behavior
 * 6), before the resolution's first write (ruling 41 of plan 12d). A row
 * that exists stays as it is, and the answer is null. A role that the
 * organization no longer has answers `role_not_found` (ruling 25 N2). Then
 * the member limit, and `organization.beforeAddMember`. So a refusal throws
 * before the claim and the identity create, and on D1 no undo runs.
 */
async function joinChecks(
  config: ResolvedConfig,
  tx: StorageAdapter,
  connection: SsoConnectionRow,
  user: UserRow,
  now: Date,
): Promise<Join | null> {
  const o = config.organizations;
  if (!o) stopWith("sso_not_configured");
  // A member needs a verified address, as `addMember` does. An SSO identity
  // comes with a proof of the address, so its user is verified.
  if (!user.emailVerified) return null;
  const organizationId = connection.organizationId;
  if (await holdsMember(tx, organizationId, user.id)) return null;
  const organization = await tx.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) stopWith("sso_not_configured");
  // A dynamic role can go after the connection names it: a delete of the role does not read the connections.
  if ((await effectiveIn(config, tx, organizationId, connection.defaultRole)).unnamed > 0)
    stopWith("role_not_found");
  if (await atMemberLimit(tx, o, organizationId)) stopWith("member_limit");
  const member: MemberRow = {
    id: newId(now),
    organizationId,
    userId: user.id,
    role: connection.defaultRole,
    createdAt: now,
    updatedAt: now,
  };
  // The hook of `addMemberIn`, which runs no hook with `checked`.
  await runBefore(
    config.observe,
    "organization.beforeAddMember",
    config.hooks.organization.beforeAddMember,
    {
      organization: publicOrganization(organization),
      member: { userId: user.id, role: member.role },
      memberUser: user,
      by: null,
      via: "sso",
      invitation: null,
    },
  );
  return { organization, member };
}

/**
 * The member row that `joinChecks` passed, in the after step. `addMemberIn`
 * takes the locks of user-hold.ts, reads the row and the count again, and
 * adds the row. Only a parallel add between the checks and the locks makes
 * it refuse here.
 */
async function joinWrite(
  config: ResolvedConfig,
  tx: StorageAdapter,
  join: Join,
  user: UserRow,
): Promise<MemberRow | null> {
  const o = config.organizations;
  if (!o) stopWith("sso_not_configured");
  const added = await addMemberIn(config, tx, o, { ...join, user, by: null, via: "sso" }, true);
  if (added.ok) return join.member;
  // A parallel sign-in added the row after the read: it stays as it is.
  if (added.code === "already_member") return null;
  stopWith(added.code === "not_found" ? "sso_not_configured" : added.code);
}

/**
 * The steps before the resolution's first write. A user whose current
 * address is not in a verified domain of the organization answers
 * `sso_domain_mismatch` (final review of plan 12d, M1). A user that SCIM
 * deactivated in this organization answers `account_disabled` (Behavior 7).
 * Then `hooks.sso.beforeSignIn` (Behavior 2), with the user, or null for a
 * create. No lock comes before them, so a throw leaves nothing.
 */
async function beforeSignIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  event: { connection: SsoConnectionSummary; profile: SsoProfile },
  email: string,
  user: UserRow,
  created: boolean,
): Promise<void> {
  if (!created) {
    // A known identity names its user, and the user can change the address
    // after the link. The domain proof gives the IdP trust only for an
    // address in the domain, so the user's own address must be in it too.
    // The profile address passed the same check, so an equal address reads
    // nothing more.
    // A user with no address (plan 12i) is in no domain. No route makes
    // such a user hold an SSO identity (ruling 18). The branch fails closed
    // and gives the domain check a string.
    if (
      user.email !== email &&
      (user.email === null ||
        !(await inOrganizationDomains(tx, event.connection.organizationId, user.email)))
    )
      stopWith("sso_domain_mismatch");
    const row = await tx.findOne("scimUser", [
      { field: "organizationId", op: "eq", value: event.connection.organizationId },
      { field: "userId", op: "eq", value: user.id },
    ]);
    if (row && !row.active) stopWith("account_disabled");
  }
  await runBefore(config.observe, "sso.beforeSignIn", config.hooks.sso.beforeSignIn, {
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
 * 3. A known identity signs in its user, only while a verified domain of
 *    the organization claims the user's current address.
 * 4. A user at the address gets the identity; an unverified one is claimed.
 * 5. No user: a just-in-time create under the sign-up rule, or
 *    `sso_not_provisioned` with `jit` off.
 * 6. The member row of the organization, with the connection's role. Its
 *    checks and its before hook run before the first write.
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
  if (email === null) return refused(config, connection, "email_required", input.ip);
  // An IdP that an organization owner configured is that owner's word. The
  // owner's DNS proof makes the word true for an address in the domain
  // (spec 30 item 11). So the IdP's email_verified is never read.
  if (!(await inOrganizationDomains(config.storage, connection.organizationId, email)))
    return refused(config, connection, "sso_domain_mismatch", input.ip);
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
      // The domain rule of a known identity read the user's address before the hold. The
      // session write reads the row again after it (ruling 78 of plan 12d).
      sameAddress: true,
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
  let join: Join | null = null;
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
        const j = join;
        joined = j ? await joinWrite(config, tx, j, user) : null;
        return gate.write(tx);
      },
      ended,
      async (tx, user, created) => {
        // A retry reads again, so the newer reads win.
        join = null;
        await beforeSignIn(config, tx, { connection: summary, profile }, email, user, created);
        // Before the gate: the session step holds the user row, a write.
        join = await joinChecks(config, tx, connection, user, now);
        await gate.before(tx, user);
      },
      steps,
    ),
  );
  if (!resolved.ok) return refused(config, connection, resolved.code, input.ip, resolved);
  const { user, after } = resolved.value;
  // After the commit, before the session hook and before a challenge answer (plan 12a).
  await verified.after(user);
  await made.after(user);
  await sessionsEnded(config, ended, "claim", verified.stops, verified.endedCount());
  const member = joined as MemberRow | null;
  if (member) {
    const organization = await config.storage.findOne("organization", [
      { field: "id", op: "eq", value: member.organizationId },
    ]);
    if (organization)
      await runAfter(
        config.observe,
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
    if (organization) config.observe.emit(organizationChange("afterAddMember", organization.id));
  }
  if (after.kind === "challenge") return ok({ ...after.pending, next, user });
  await touchTrust(config, gate.trustId(), now);
  const key = gateOn ? passedKey(connection.mfa, profile) : null;
  // The pass of the second factor by the IdP (spec 30 item 13): the key name, and no new field.
  if (key !== null)
    config.observe.emit({ name: "sso.second_factor_idp", connectionId: connection.id, claim: key });
  await sessionOpened(config, after.session, user, "sso");
  return ok({ token: after.token, next, user });
}

/**
 * One fault event of a refused resolution: the connection id and the code
 * (Global Constraints of plan 12d). The IP is an address input, so only the
 * include rule writes it (plan 12h). `result` keeps the hook text of a
 * refusal.
 */
function refused(
  config: ResolvedConfig,
  connection: SsoConnectionRow,
  code: Exclude<Result<never>, { ok: true }>["code"],
  ip: string | null,
  result?: Result<never>,
): Result<never> {
  config.observe.emit({ name: "sso.refused", connectionId: connection.id, code, ip });
  return result ?? fail(code);
}
