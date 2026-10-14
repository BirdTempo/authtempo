import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { InvitationRow, MemberRow, OrganizationRow, UserRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { HookStop, hookGuard, runAfter, runBefore } from "./hooks.js";
import {
  type Caller,
  type MemberSummary,
  membership,
  type OrganizationSummary,
  publicOrganization,
} from "./organizations.js";
import { needs, type ResolvedOrganizations, ROLE_RE, rankOf, roleAllowedIn } from "./ranks.js";
import { publicSession, type ResolvedSession } from "./sessions.js";
import { normalizeEmail } from "./users.js";

export const INVITATION_PREFIX = "inv_";
export const INVITATION_TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const ACCEPT_LIMIT = { seconds: 15 * 60, max: 20 };
/** Each invite sends a mail from the app's sender. The product owns this limit, not the mail supplier. */
const INVITE_USER_LIMIT = { seconds: 15 * 60, max: 20 };
const INVITE_EMAIL_LIMIT = { seconds: 60 * 60, max: 5 };

export interface InvitationSummary {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  inviterId: string;
  expiresAt: Date;
  createdAt: Date;
}

function summary(row: InvitationRow): InvitationSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    inviterId: row.inviterId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** The caller's standing for an admin rule on this organization. Same codes as the organizations engine. */
async function adminStanding(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  input: Caller & { organizationId: string },
  rule: "invite" | "invitations" | "revoke",
) {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: input.organizationId },
  ]);
  if (!organization) return fail<{ organization: OrganizationRow; rank: number }>("not_found");
  const m = await membership(config, input.organizationId, input.user.id);
  if (!m || m.rank < needs(o, rule))
    return fail<{ organization: OrganizationRow; rank: number }>("forbidden_rank");
  return ok({ organization, rank: m.rank });
}

export async function inviteMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; email: string; role: string },
): Promise<Result<InvitationSummary>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const s = await adminStanding(config, o, input, "invite");
  if (!s.ok) return s;
  const email = normalizeEmail(input.email);
  if (email === null) return fail("invalid_body");
  if (!ROLE_RE.test(input.role) || !roleAllowedIn(o, input.role, s.value.organization.slug))
    return fail("invalid_body");
  const rank = rankOf(o.ranks, input.role);
  if (rank === 0 || rank > s.value.rank) return fail("forbidden_rank");
  // After the rank checks, so a stranger cannot spend an admin's budget.
  if (!(await config.limiter.allow(`invite:user:${input.user.id}`, INVITE_USER_LIMIT)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`invite:email:${email}`, INVITE_EMAIL_LIMIT)))
    return fail("rate_limited");
  const now = config.clock.now();
  const token = randomToken(INVITATION_PREFIX);
  const row: InvitationRow = {
    id: newId(now),
    organizationId: input.organizationId,
    email,
    role: input.role,
    inviterId: input.user.id,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + o.invitationTtlDays * 86_400_000),
    acceptedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const hooks = config.hooks.organization;
  const organization = publicOrganization(s.value.organization);
  const limit = o.limits.pendingInvitationsPerOrganization;
  const written = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<true>> => {
      if (limit !== null) {
        // The address's own pending row does not count: the invite below replaces it.
        const pending = await tx.findMany(
          "invitation",
          [
            { field: "organizationId", op: "eq", value: input.organizationId },
            { field: "acceptedAt", op: "eq", value: null },
            { field: "expiresAt", op: "gt", value: now },
            { field: "email", op: "ne", value: email },
          ],
          { limit },
        );
        if (pending.length >= limit) return fail("invitation_limit");
      }
      await runBefore("organization.beforeInvite", hooks.beforeInvite, {
        organization,
        invitation: { email, role: input.role },
        by: input.user,
      });
      // One pending invitation per address: a new invite replaces the old one, so the old link dies.
      await tx.delete("invitation", [
        { field: "organizationId", op: "eq", value: input.organizationId },
        { field: "email", op: "eq", value: email },
        { field: "acceptedAt", op: "eq", value: null },
      ]);
      await tx.create("invitation", row);
      return ok(true);
    }),
  );
  if (!written.ok) return written;
  // Right after the commit, before the mail: the row exists whatever the mail does.
  await runAfter(
    "organization.afterInvite",
    hooks.afterInvite,
    { organization, invitation: summary(row), by: input.user },
    row.id,
  );
  const link = o.invitationLinkBuilder(token, {
    slug: s.value.organization.slug,
    name: s.value.organization.name,
  });
  await config.mail.send({
    to: email,
    subject: `You are invited to ${s.value.organization.name} on ${config.appName}`,
    text: `${input.user.email} invited you to ${s.value.organization.name} on ${config.appName}. Open this link to accept. It is valid for ${o.invitationTtlDays} days.\n\n${link}\n\nIf you do not know this organization, ignore this message.`,
  });
  return ok(summary(row));
}

export async function listInvitations(
  config: ResolvedConfig,
  input: Caller & { organizationId: string },
): Promise<Result<InvitationSummary[]>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  const s = await adminStanding(config, o, input, "invitations");
  if (!s.ok) return s;
  const now = config.clock.now();
  const rows = await config.storage.findMany(
    "invitation",
    [
      { field: "organizationId", op: "eq", value: input.organizationId },
      { field: "acceptedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    {
      sort: [
        { field: "email", dir: "asc" },
        { field: "id", dir: "asc" },
      ],
    },
  );
  return ok(rows.map(summary));
}

export async function revokeInvitation(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; invitationId: string },
): Promise<Result<{ ok: true }>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const s = await adminStanding(config, o, input, "revoke");
  if (!s.ok) return s;
  // The organization id is in the where, so an admin of another organization cannot reach this row.
  const where = [
    { field: "id", op: "eq", value: input.invitationId },
    { field: "organizationId", op: "eq", value: input.organizationId },
  ] as const;
  // Read first, for the after hook's event.
  const row = await config.storage.findOne("invitation", [...where]);
  if (!row) return fail("not_found");
  if ((await config.storage.delete("invitation", [...where])) === 0) return fail("not_found");
  await runAfter(
    "organization.afterRevokeInvitation",
    config.hooks.organization.afterRevokeInvitation,
    {
      organization: publicOrganization(s.value.organization),
      invitation: summary(row),
      by: input.user,
    },
    row.id,
  );
  return ok({ ok: true });
}

/** The member row as the API shows it, with the accepting user's address and name. */
function memberSummary(row: MemberRow, user: UserRow): MemberSummary {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    email: user.email,
    name: user.name,
    createdAt: row.createdAt,
  };
}

async function liveInvitation(
  config: ResolvedConfig,
  token: string,
): Promise<Result<InvitationRow>> {
  if (!INVITATION_TOKEN_RE.test(token)) return fail("invalid_token");
  const row = await config.storage.findOne("invitation", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!row || row.acceptedAt !== null) return fail("invalid_token");
  if (row.expiresAt.getTime() <= config.clock.now().getTime()) return fail("token_expired");
  return ok(row);
}

/**
 * What the accept transaction answers: the member row, whether it is new, and
 * for a raise of an existing member the role before and the inviter's user;
 * or why it stopped.
 */
type Accepted =
  | { row: MemberRow; created: boolean; raised: { previousRole: string; by: UserRow } | null }
  | "inviter_lost"
  | "member_limit"
  | null;

export async function acceptInvitation(
  config: ResolvedConfig,
  input: Caller & { token: string; ip: string | null },
): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!(await config.limiter.allow(`invitation-accept:ip:${ipKey(input.ip)}`, ACCEPT_LIMIT)))
    return fail("rate_limited");
  const live = await liveInvitation(config, input.token);
  if (!live.ok) return live;
  const inv = live.value;
  // The same rule as a social claim: only the verified holder of the invited address may accept.
  if (!input.user.emailVerified) return fail("email_unverified");
  if (input.user.email !== inv.email) return fail("email_mismatch");
  const organizationRow = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: inv.organizationId },
  ]);
  if (!organizationRow) return fail("invalid_token");
  const now = config.clock.now();
  const hooks = config.hooks.organization;
  const organization = publicOrganization(organizationRow);
  const invitation = summary(inv);
  const limit = o.limits.membersPerOrganization;
  let accepted: Accepted = null;
  try {
    accepted = await config.storage.transaction(async (tx): Promise<Accepted> => {
      // An invitation carries its inviter's rank at the time of the invite. If the inviter was
      // removed or demoted since, the grant must die with their right; the check runs here because
      // a removal cannot find every pending invitation by rank.
      const inviter = await tx.findOne("member", [
        { field: "organizationId", op: "eq", value: inv.organizationId },
        { field: "userId", op: "eq", value: inv.inviterId },
      ]);
      const inviterRank = inviter ? rankOf(o.ranks, inviter.role) : 0;
      const grantRank = rankOf(o.ranks, inv.role);
      // The rank table or the organization slug can change after the invite. A role that now ranks 0, or a
      // platform role outside the platform organization, is a grant no live caller could make.
      if (
        inviterRank < needs(o, "invite") ||
        inviterRank < grantRank ||
        grantRank === 0 ||
        !roleAllowedIn(o, inv.role, organizationRow.slug)
      ) {
        // Only a pending row: an accepted row is a record of a grant that already happened.
        await tx.delete("invitation", [
          { field: "id", op: "eq", value: inv.id },
          { field: "acceptedAt", op: "eq", value: null },
        ]);
        return "inviter_lost";
      }
      const existing = await tx.findOne("member", [
        { field: "organizationId", op: "eq", value: inv.organizationId },
        { field: "userId", op: "eq", value: input.user.id },
      ]);
      // The limit counts a new member row only: a raise of an existing member adds none.
      if (!existing && limit !== null) {
        const held = await tx.findMany(
          "member",
          [{ field: "organizationId", op: "eq", value: inv.organizationId }],
          { limit },
        );
        if (held.length >= limit) return "member_limit";
      }
      // Before the consume, on every accept, as Better Auth's beforeAcceptInvitation.
      // A refusal throws, so the invitation stays pending.
      await runBefore("organization.beforeAddMember", hooks.beforeAddMember, {
        organization,
        member: { userId: input.user.id, role: inv.role },
        memberUser: input.user,
        by: input.user,
        via: "invitation",
        invitation,
      });
      // An accept that raises an existing member's role is a role change: the role hooks see it
      // as they see updateMemberRole (final fix wave I-1). Before the consume, so a refusal throws
      // before any write and the invitation stays pending. `by` is the inviter, whose rank grants
      // the role; the accepting user when the inviter's user row is gone.
      const raise = existing !== null && grantRank > rankOf(o.ranks, existing.role);
      let raisedBy: UserRow = input.user;
      if (existing && raise) {
        raisedBy =
          (await tx.findOne("user", [{ field: "id", op: "eq", value: inv.inviterId }])) ??
          input.user;
        await runBefore("organization.beforeUpdateMemberRole", hooks.beforeUpdateMemberRole, {
          organization,
          member: memberSummary(existing, input.user),
          role: inv.role,
          memberUser: input.user,
          by: raisedBy,
        });
      }
      // One conditional update consumes the token: two accepts race for one row and only one wins.
      const n = await tx.update(
        "invitation",
        [
          { field: "id", op: "eq", value: inv.id },
          { field: "acceptedAt", op: "eq", value: null },
        ],
        { acceptedAt: now, updatedAt: now },
      );
      if (n === 0) return null;
      if (existing) {
        if (raise) {
          await tx.update("member", [{ field: "id", op: "eq", value: existing.id }], {
            role: inv.role,
            updatedAt: now,
          });
          return {
            row: { ...existing, role: inv.role, updatedAt: now },
            created: false,
            raised: { previousRole: existing.role, by: raisedBy },
          };
        }
        return { row: existing, created: false, raised: null };
      }
      const row: MemberRow = {
        id: newId(now),
        organizationId: inv.organizationId,
        userId: input.user.id,
        role: inv.role,
        createdAt: now,
        updatedAt: now,
      };
      await tx.create("member", row);
      return { row, created: true, raised: null };
    });
  } catch (err) {
    if (err instanceof HookStop) return err.result;
    // A concurrent addMember won the unique key; the transaction rolled back, so the token is still live. The person retries.
    if (err instanceof StorageError && err.code === "unique_violation")
      return fail("already_member");
    throw err;
  }
  // The limit answers before any write, so the invitation stays pending.
  if (accepted === "member_limit") return fail("member_limit");
  // Both a lost race for the token and a lost inviter answer invalid_token: the link is dead either way.
  if (accepted === null || accepted === "inviter_lost") return fail("invalid_token");
  const member = memberSummary(accepted.row, input.user);
  if (accepted.raised)
    await runAfter(
      "organization.afterUpdateMemberRole",
      hooks.afterUpdateMemberRole,
      {
        organization,
        member,
        previousRole: accepted.raised.previousRole,
        memberUser: input.user,
        by: accepted.raised.by,
      },
      member.id,
    );
  if (accepted.created)
    await runAfter(
      "organization.afterAddMember",
      hooks.afterAddMember,
      {
        organization,
        member,
        memberUser: input.user,
        by: input.user,
        via: "invitation",
        invitation,
      },
      member.id,
    );
  await runAfter(
    "organization.afterAcceptInvitation",
    hooks.afterAcceptInvitation,
    { organization, invitation, member, user: input.user },
    inv.id,
  );
  return ok({ organization, member });
}

/**
 * Decline needs the token only: the link in the mail is the credential.
 * `user` is the user of the session the request carried, if any, for the
 * after hook's event. It is not checked against the invitation's address.
 */
export async function declineInvitation(
  config: ResolvedConfig,
  input: { token: string; user?: UserRow | null },
): Promise<Result<{ ok: true }>> {
  if (!config.organizations) return fail("not_found");
  const live = await liveInvitation(config, input.token);
  if (!live.ok) return live;
  const inv = live.value;
  const n = await config.storage.delete("invitation", [
    { field: "id", op: "eq", value: inv.id },
    { field: "acceptedAt", op: "eq", value: null },
  ]);
  if (n === 0) return fail("invalid_token");
  const hook = config.hooks.organization.afterDeclineInvitation;
  if (hook) {
    const organization = await config.storage.findOne("organization", [
      { field: "id", op: "eq", value: inv.organizationId },
    ]);
    if (organization)
      await runAfter(
        "organization.afterDeclineInvitation",
        hook,
        {
          organization: publicOrganization(organization),
          invitation: summary(inv),
          user: input.user ?? null,
        },
        inv.id,
      );
  }
  return ok({ ok: true });
}

export async function setActiveOrganization(
  config: ResolvedConfig,
  input: { session: ResolvedSession; organizationId: string | null },
): Promise<Result<ReturnType<typeof publicSession>>> {
  if (!config.organizations) return fail("not_found");
  if (input.organizationId !== null) {
    const m = await membership(config, input.organizationId, input.session.user.id);
    if (!m) return fail("forbidden_rank");
  }
  const now = config.clock.now();
  await config.storage.update(
    "session",
    [{ field: "id", op: "eq", value: input.session.session.id }],
    { activeOrganizationId: input.organizationId, updatedAt: now },
  );
  return ok(
    publicSession({
      ...input.session,
      session: {
        ...input.session.session,
        activeOrganizationId: input.organizationId,
        updatedAt: now,
      },
    }),
  );
}
