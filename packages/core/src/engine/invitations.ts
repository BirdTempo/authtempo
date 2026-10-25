import { can } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { organizationChange } from "../observe/events.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { InvitationRow, MemberRow, OrganizationRow, TeamRow, UserRow } from "../schema.js";
import { findManyIn } from "../storage/batch.js";
import { StorageError, type Where } from "../storage/port.js";
import { HookStop, hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import {
  type Caller,
  grantable,
  type MemberSummary,
  membership,
  type OrganizationSummary,
  publicOrganization,
} from "./organizations.js";
import { effectiveIn, grantCheck, type Standing, touchCheck } from "./permissions.js";
import { RULE_STATEMENTS, rankOf, roleAllowedIn } from "./ranks.js";
import { publicSession, type ResolvedSession } from "./sessions.js";
import { lockOrganization, lockTeam, TEAM_MEMBER_ADD } from "./teams.js";
import { holdUser, userStays } from "./user-hold.js";
import { normalizeEmail } from "./users.js";

export const INVITATION_PREFIX = "inv_";
export const INVITATION_TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const ACCEPT_LIMIT = { seconds: 15 * 60, max: 20 };
/** Each invite sends a mail from the app's sender. The product owns this limit, not the mail supplier. */
const INVITE_USER_LIMIT = { seconds: 15 * 60, max: 20 };
const INVITE_EMAIL_LIMIT = { seconds: 60 * 60, max: 5 };
/** The most teams that one invitation names (plan 12k). */
const INVITE_TEAMS_MAX = 20;

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

/** The caller's standing for the statements of an admin rule on this organization. Same codes as the organizations engine. */
async function adminStanding(
  config: ResolvedConfig,
  input: Caller & { organizationId: string },
  rule: "invite" | "invitations" | "revoke",
): Promise<Result<{ organization: OrganizationRow; standing: Standing }>> {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: input.organizationId },
  ]);
  if (!organization) return fail("not_found");
  const m = await membership(config, input.organizationId, input.user.id);
  if (!m) return fail("forbidden_rank");
  const standing = await effectiveIn(config, config.storage, input.organizationId, m.member.role);
  if (!can(standing.granted, RULE_STATEMENTS[rule])) return fail("forbidden_rank");
  return ok({ organization, standing });
}

/**
 * The team ids of an invite (plan 12k): with teams on, at most 20 distinct
 * ids, each a team of the organization; else `invalid_body`. An empty list
 * is null. One read for each 50 ids.
 */
async function inviteTeams(
  config: ResolvedConfig,
  organizationId: string,
  teamIds: string[] | undefined,
): Promise<Result<string[] | null>> {
  if (teamIds === undefined) return ok(null);
  if (!config.organizations?.teams) return fail("invalid_body");
  if (
    !Array.isArray(teamIds) ||
    teamIds.length > INVITE_TEAMS_MAX ||
    teamIds.some((id) => typeof id !== "string") ||
    new Set(teamIds).size !== teamIds.length
  )
    return fail("invalid_body");
  if (teamIds.length === 0) return ok(null);
  const found = await findManyIn(config.storage, "team", "id", teamIds, [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
  return found.length === teamIds.length ? ok([...teamIds]) : fail("invalid_body");
}

export async function inviteMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; email: string; role: string; teamIds?: string[] },
): Promise<Result<InvitationSummary>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const s = await adminStanding(config, input, "invite");
  if (!s.ok) return s;
  const email = normalizeEmail(input.email);
  if (email === null) return fail("invalid_body");
  const g = await grantable(config, o, s.value.organization, s.value.standing, input.role);
  if (!g.ok) return g;
  const teams = await inviteTeams(config, input.organizationId, input.teamIds);
  if (!teams.ok) return teams;
  // The accept adds the person to each team, so the inviter needs the right of a team member add.
  if (teams.value !== null && !can(s.value.standing.granted, TEAM_MEMBER_ADD))
    return fail("forbidden_rank");
  // After the rank checks, so a stranger cannot spend an admin's budget.
  if (!(await limit(config, "invite:user", input.user.id, INVITE_USER_LIMIT)))
    return fail("rate_limited");
  if (!(await limit(config, "invite:email", email, INVITE_EMAIL_LIMIT)))
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
    teamIds: teams.value,
    createdAt: now,
    updatedAt: now,
  };
  const hooks = config.hooks.organization;
  const organization = publicOrganization(s.value.organization);
  const pendingLimit = o.limits.pendingInvitationsPerOrganization;
  const written = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<true>> => {
      if (pendingLimit !== null) {
        // The lock of the count (ruling 45 of plan 12k). A second invite waits here for this
        // commit, and then counts its row. A gone organization answers not_found.
        if (!(await lockOrganization(tx, s.value.organization))) return fail("not_found");
        // The address's own pending row does not count: the invite below replaces it.
        const pending = await tx.findMany(
          "invitation",
          [
            { field: "organizationId", op: "eq", value: input.organizationId },
            { field: "acceptedAt", op: "eq", value: null },
            { field: "expiresAt", op: "gt", value: now },
            { field: "email", op: "ne", value: email },
          ],
          { limit: pendingLimit },
        );
        if (pending.length >= pendingLimit) return fail("invitation_limit");
      }
      await runBefore(config.observe, "organization.beforeInvite", hooks.beforeInvite, {
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
    config.observe,
    "organization.afterInvite",
    hooks.afterInvite,
    { organization, invitation: summary(row), by: input.user },
    row.id,
  );
  config.observe.emit(organizationChange("afterInvite", organization.id));
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
  const s = await adminStanding(config, input, "invitations");
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
  const s = await adminStanding(config, input, "revoke");
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
    config.observe,
    "organization.afterRevokeInvitation",
    config.hooks.organization.afterRevokeInvitation,
    {
      organization: publicOrganization(s.value.organization),
      invitation: summary(row),
      by: input.user,
    },
    row.id,
  );
  config.observe.emit(organizationChange("afterRevokeInvitation", s.value.organization.id));
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
  | "team_member_limit"
  | null;

export async function acceptInvitation(
  config: ResolvedConfig,
  input: Caller & { token: string; ip: string | null },
): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!(await limit(config, "invitation-accept:ip", ipKey(input.ip), ACCEPT_LIMIT)))
    return fail("rate_limited");
  const live = await liveInvitation(config, input.token);
  if (!live.ok) return live;
  const inv = live.value;
  // The same rule as a social claim: only the verified holder of the invited address may accept.
  // The address compare comes first, so a user with no address answers
  // email_mismatch (spec 32 item 1, ruling 15 of plan 12i).
  if (input.user.email !== inv.email) return fail("email_mismatch");
  if (!input.user.emailVerified) return fail("email_unverified");
  const organizationRow = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: inv.organizationId },
  ]);
  if (!organizationRow) return fail("invalid_token");
  const now = config.clock.now();
  const hooks = config.hooks.organization;
  const organization = publicOrganization(organizationRow);
  const invitation = summary(inv);
  const memberLimit = o.limits.membersPerOrganization;
  const teamLimit = o.limits.membersPerTeam;
  const teamIds = o.teams ? (inv.teamIds ?? []) : [];
  let accepted: Accepted = null;
  try {
    accepted = await config.storage.transaction(async (tx): Promise<Accepted> => {
      // First, in the lock order of user-hold.ts: the user row, then the team rows (ruling 43).
      // A member row of a deleted user would count as an owner (plan 12a Task 11). The hold
      // writes no new value, so a refusal below changes nothing.
      await holdUser(config.observe, tx, input.user.id);
      // An invitation carries its inviter's rank at the time of the invite. If the inviter was
      // removed or demoted since, the grant must die with their right; the check runs here because
      // a removal cannot find every pending invitation by rank.
      const inviter = await tx.findOne("member", [
        { field: "organizationId", op: "eq", value: inv.organizationId },
        { field: "userId", op: "eq", value: inv.inviterId },
      ]);
      const by: Standing = inviter
        ? await effectiveIn(config, tx, inv.organizationId, inviter.role)
        : { rank: 0, granted: {} };
      const grant = await effectiveIn(config, tx, inv.organizationId, inv.role);
      const grantRank = grant.rank;
      // Only a pending row: an accepted row is a record of a grant that already happened.
      const lost = async (): Promise<"inviter_lost"> => {
        await tx.delete("invitation", [
          { field: "id", op: "eq", value: inv.id },
          { field: "acceptedAt", op: "eq", value: null },
        ]);
        return "inviter_lost";
      };
      // The role table or the organization slug can change after the invite. A role that now ranks 0, or a
      // platform role outside the platform organization, is a grant no live caller could make. So is a
      // part that no table names while dynamic roles are on, as in grantable.
      if (
        !can(by.granted, RULE_STATEMENTS.invite) ||
        !grantCheck(by, grant) ||
        grantRank === 0 ||
        (o.dynamicRoles !== null && grant.unnamed > 0) ||
        !roleAllowedIn(o, inv.role, organizationRow.slug)
      )
        return lost();
      // After the hold: a member removal holds the same user (ruling 43). So the removal commits
      // before this read, or it waits for this commit and then deletes the new team rows.
      const existing = await tx.findOne("member", [
        { field: "organizationId", op: "eq", value: inv.organizationId },
        { field: "userId", op: "eq", value: input.user.id },
      ]);
      const raise = existing !== null && grantRank > rankOf(o.ranks, existing.role);
      // A raise changes the role of a member, so the inviter must also pass the touch rule on
      // the current role (spec 29 item 5). Else an inviter could drop a statement it does not hold.
      if (
        existing &&
        raise &&
        !touchCheck(by, await effectiveIn(config, tx, inv.organizationId, existing.role))
      )
        return lost();
      // The limit counts a new member row only: a raise of an existing member adds none.
      if (!existing && memberLimit !== null) {
        // The lock of the count, after the user hold and before the team locks (ruling 45 of
        // plan 12k). A second add or accept waits here for this commit. A gone organization
        // makes the link dead.
        if (!(await lockOrganization(tx, organizationRow))) return null;
        const held = await tx.findMany(
          "member",
          [{ field: "organizationId", op: "eq", value: inv.organizationId }],
          { limit: memberLimit },
        );
        if (held.length >= memberLimit) return "member_limit";
      }
      // Plan 12k: the teams of the invitation that still exist. A missing team is skipped. A full
      // team answers before any write, so the invitation stays pending. The lock of each team row
      // holds a team delete until the commit (ruling 26). The id order keeps two accepts from a
      // deadlock.
      const joins: TeamRow[] = [];
      const found = await findManyIn(tx, "team", "id", teamIds, [
        { field: "organizationId", op: "eq", value: inv.organizationId },
      ]);
      for (const team of found.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        // Zero rows: a delete ran after the read, so the team is skipped as a missing one.
        if (!(await lockTeam(tx, team.id, inv.organizationId))) continue;
        if (
          await tx.findOne("teamMember", [
            { field: "teamId", op: "eq", value: team.id },
            { field: "userId", op: "eq", value: input.user.id },
          ])
        )
          continue;
        if (teamLimit !== null) {
          const held = await tx.findMany(
            "teamMember",
            [{ field: "teamId", op: "eq", value: team.id }],
            { limit: teamLimit },
          );
          if (held.length >= teamLimit) return "team_member_limit";
        }
        joins.push(team);
      }
      // Before the consume, on every accept, as Better Auth's beforeAcceptInvitation.
      // A refusal throws, so the invitation stays pending.
      await runBefore(config.observe, "organization.beforeAddMember", hooks.beforeAddMember, {
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
      let raisedBy: UserRow = input.user;
      if (existing && raise) {
        raisedBy =
          (await tx.findOne("user", [{ field: "id", op: "eq", value: inv.inviterId }])) ??
          input.user;
        await runBefore(
          config.observe,
          "organization.beforeUpdateMemberRole",
          hooks.beforeUpdateMemberRole,
          {
            organization,
            member: memberSummary(existing, input.user),
            role: inv.role,
            memberUser: input.user,
            by: raisedBy,
          },
        );
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
      // The team rows are part of the accept, so they fire no team hook.
      for (const team of joins)
        await tx.create("teamMember", {
          id: newId(now),
          teamId: team.id,
          organizationId: inv.organizationId,
          userId: input.user.id,
          createdAt: now,
          updatedAt: now,
        });
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
      await userStays(tx, row.userId);
      // D1 has no lock. An account delete removes a solo organization's row
      // before its members. So this read sees it gone, or that delete sees
      // the new member and answers conflict (plan 12a Task 11).
      if (
        !(await tx.findOne("organization", [{ field: "id", op: "eq", value: row.organizationId }]))
      )
        stopWith("conflict");
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
  if (accepted === "team_member_limit") return fail("team_member_limit");
  // Both a lost race for the token and a lost inviter answer invalid_token: the link is dead either way.
  if (accepted === null || accepted === "inviter_lost") return fail("invalid_token");
  const member = memberSummary(accepted.row, input.user);
  if (accepted.raised) {
    await runAfter(
      config.observe,
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
    config.observe.emit(organizationChange("afterUpdateMemberRole", organization.id));
  }
  if (accepted.created) {
    await runAfter(
      config.observe,
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
    config.observe.emit(organizationChange("afterAddMember", organization.id));
  }
  await runAfter(
    config.observe,
    "organization.afterAcceptInvitation",
    hooks.afterAcceptInvitation,
    { organization, invitation, member, user: input.user },
    inv.id,
  );
  config.observe.emit(organizationChange("afterAcceptInvitation", organization.id));
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
        config.observe,
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
  config.observe.emit(organizationChange("afterDeclineInvitation", inv.organizationId));
  return ok({ ok: true });
}

export async function setActiveOrganization(
  config: ResolvedConfig,
  input: { session: ResolvedSession; organizationId: string | null },
): Promise<Result<ReturnType<typeof publicSession>>> {
  if (!config.organizations) return fail("not_found");
  const organizationId = input.organizationId;
  const now = config.clock.now();
  // A team belongs to one organization, so a change of the active organization clears the
  // active team in the same update (plan 12k). The same organization keeps it, so the update
  // leaves the field out. A team delete can clear it after the read of this session, and the
  // old id must not come back (ruling 51 of plan 12k).
  const same = organizationId === input.session.session.activeOrganizationId;
  const activeTeamId = same ? input.session.session.activeTeamId : null;
  const byId: Where<"session">[] = [{ field: "id", op: "eq", value: input.session.session.id }];
  const data = same
    ? { activeOrganizationId: organizationId, updatedAt: now }
    : { activeOrganizationId: organizationId, activeTeamId: null, updatedAt: now };
  if (organizationId === null) await config.storage.update("session", byId, data);
  else {
    const set = await config.storage.transaction(async (tx): Promise<boolean> => {
      // The session lock, then the organization row, in the order of user-hold.ts (ruling 50
      // of plan 12k). An organization delete that holds the row commits first, and this set
      // then finds it gone. So no session moves into an organization after its delete read.
      await tx.lockInOrder?.("session", byId);
      const organization = await tx.findOne("organization", [
        { field: "id", op: "eq", value: organizationId },
      ]);
      if (!organization) return false;
      // D1 has no row lock, so there the lock holds nothing and costs no statement.
      if (tx.lockInOrder && !(await lockOrganization(tx, organization))) return false;
      const member = await tx.findOne("member", [
        { field: "organizationId", op: "eq", value: organizationId },
        { field: "userId", op: "eq", value: input.session.user.id },
      ]);
      if (!member) return false;
      await tx.update("session", byId, data);
      return true;
    });
    if (!set) return fail("forbidden_rank");
  }
  return ok(
    publicSession({
      ...input.session,
      session: {
        ...input.session.session,
        activeOrganizationId: input.organizationId,
        activeTeamId,
        updatedAt: now,
      },
    }),
  );
}
