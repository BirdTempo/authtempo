import type { ResolvedConfig } from "../../config.js";
import { organizationChange } from "../../observe/events.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import type { MemberRow, OrganizationRow, UserRow } from "../../schema.js";
import { meterOf } from "../../storage/meter.js";
import { type StorageAdapter, StorageError } from "../../storage/port.js";
import { createSteps } from "../create-steps.js";
import { runAfter, runBefore } from "../hooks.js";
import {
  isOwner,
  type MemberSummary,
  type OrganizationSummary,
  ownerLock,
  publicOrganization,
} from "../organizations.js";
import { holdsRolePart, type ResolvedOrganizations, rankOf } from "../ranks.js";
import { sessionsEnded } from "../sessions.js";
import { dropMemberTeams } from "../teams.js";
import { holdUser, userStays } from "../user-hold.js";
import { normalizeEmail, validUserName } from "../users.js";
import {
  ACCESS_END_KEEP,
  ACCESS_END_LEAST,
  endAllAccessPage,
  endImpersonationsPage,
  hasPendingEnd,
} from "./access-end.js";
import {
  auditDraft,
  impersonationStops,
  type OperatorActEnds,
  operatorAct,
  operatorReason,
} from "./audit.js";
import { targetOf } from "./ban.js";
import { activeBan } from "./ban-rule.js";
import { type OperatorActor, requireScope } from "./guards.js";
import { holdImpersonations } from "./impersonation.js";
import { STEP_WORST, TARGET_CALLS, workBudget } from "./sessions.js";

/** The input of a grant or a revoke of the platform role (spec 26 item 5). */
export interface PlatformRoleInput {
  actor: OperatorActor;
  userId: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/** The input of `createAdmin` (spec 26 item 11). `name` is the new user's name; an existing user keeps theirs. */
export interface CreateAdminInput {
  actor: OperatorActor;
  email: string;
  name?: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
}

/** The platform role and the platform organization's slug of the config. */
interface Platform {
  o: ResolvedOrganizations;
  role: string;
  slug: string;
}

/**
 * The first checks of the three acts, in this order. The tool is on:
 * `operator.users` and `organizations.platformRole`, else `not_found`. The
 * actor holds the scope `users`. The reason is valid.
 */
function platformOf(
  config: ResolvedConfig,
  input: { actor: OperatorActor; reason: unknown },
): Result<Platform & { reason: string }> {
  const o = config.organizations;
  if (!config.operator?.users || !o || o.platformRole === null || o.platformOrganization === null)
    return fail("not_found");
  const scoped = requireScope(input.actor, "users");
  if (!scoped.ok) return scoped;
  const reason = operatorReason(input.reason);
  if (!reason.ok) return reason;
  return ok({ o, role: o.platformRole, slug: o.platformOrganization, reason: reason.value });
}

/** The user who acts in a member hook event, or null for a secret and the app. */
function byOf(actor: OperatorActor): UserRow | null {
  return actor.kind === "user" ? actor.user : null;
}

function memberSummary(member: MemberRow, user: UserRow): MemberSummary {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    email: user.email,
    name: user.name,
    createdAt: member.createdAt,
  };
}

/** The change of an added role part: a new row, or new parts of a row. Null: no change. */
type PartChange =
  | { kind: "add"; member: MemberRow }
  | { kind: "role"; member: MemberRow; previousRole: string }
  | null;

/** What an act did to the member row, for the hooks after the commit. Null: no change. */
type MemberChange = PartChange | { kind: "remove"; member: MemberRow };

/** The member hooks after the commit (plan 9d), with `via: "operator"`. */
async function memberChanged(
  config: ResolvedConfig,
  organization: OrganizationSummary,
  user: UserRow,
  by: UserRow | null,
  change: MemberChange,
): Promise<void> {
  if (change === null) return;
  const hooks = config.hooks.organization;
  const member = memberSummary(change.member, user);
  if (change.kind === "add")
    await runAfter(
      config.observe,
      "organization.afterAddMember",
      hooks.afterAddMember,
      { organization, member, memberUser: user, by, via: "operator", invitation: null },
      change.member.id,
    );
  else if (change.kind === "role")
    await runAfter(
      config.observe,
      "organization.afterUpdateMemberRole",
      hooks.afterUpdateMemberRole,
      { organization, member, previousRole: change.previousRole, memberUser: user, by },
      change.member.id,
    );
  else
    await runAfter(
      config.observe,
      "organization.afterRemoveMember",
      hooks.afterRemoveMember,
      { organization, member, memberUser: user, by, via: "operator" },
      change.member.id,
    );
  config.observe.emit(
    organizationChange(
      change.kind === "add"
        ? "afterAddMember"
        : change.kind === "role"
          ? "afterUpdateMemberRole"
          : "afterRemoveMember",
      organization.id,
    ),
  );
}

/**
 * The checks and the before hook of an added role part, with no write. The
 * change is a new member row with `role` alone, or `role` added to the
 * parts of the row that exists. A row that holds the part already changes
 * nothing. A new row counts against `membersPerOrganization` (plan 9d).
 * The caller runs every before hook first (the D1 undo), then holds the
 * user row, then calls `writePart`.
 */
async function addRolePart(
  config: ResolvedConfig,
  tx: StorageAdapter,
  p: Platform,
  input: {
    organization: OrganizationRow;
    user: UserRow;
    role: string;
    member: MemberRow | null;
    by: UserRow | null;
  },
  now: Date,
): Promise<Result<PartChange>> {
  const hooks = config.hooks.organization;
  const organization = publicOrganization(input.organization);
  const { user, member, by } = input;
  if (member && holdsRolePart(member.role, p.role)) return ok(null);
  if (member) {
    const role = `${member.role},${p.role}`;
    await runBefore(
      config.observe,
      "organization.beforeUpdateMemberRole",
      hooks.beforeUpdateMemberRole,
      {
        organization,
        member: memberSummary(member, user),
        role,
        memberUser: user,
        by,
      },
    );
    return ok({
      kind: "role",
      member: { ...member, role, updatedAt: now },
      previousRole: member.role,
    });
  }
  const limit = p.o.limits.membersPerOrganization;
  if (limit !== null) {
    const held = await tx.findMany(
      "member",
      [{ field: "organizationId", op: "eq", value: input.organization.id }],
      { limit },
    );
    if (held.length >= limit) return fail("member_limit");
  }
  const row: MemberRow = {
    id: newId(now),
    organizationId: input.organization.id,
    userId: user.id,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
  await runBefore(config.observe, "organization.beforeAddMember", hooks.beforeAddMember, {
    organization,
    member: { userId: user.id, role: row.role },
    memberUser: user,
    by,
    via: "operator",
    invitation: null,
  });
  return ok({ kind: "add", member: row });
}

/**
 * The member write of an added role part. The role from the read is in the
 * where, so a parallel change matches zero rows and answers `conflict`.
 */
async function writePart(tx: StorageAdapter, change: PartChange): Promise<Result<true>> {
  if (change?.kind === "add") await tx.create("member", change.member);
  else if (change?.kind === "role") {
    const n = await tx.update(
      "member",
      [
        { field: "id", op: "eq", value: change.member.id },
        { field: "role", op: "eq", value: change.previousRole },
      ],
      { role: change.member.role, updatedAt: change.member.updatedAt },
    );
    if (n === 0) return fail("conflict");
  }
  return ok(true);
}

/** The member row of `userId` in the organization, read through `storage`. */
function memberOf(storage: StorageAdapter, organizationId: string, userId: string) {
  return storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
}

/** A unique key that a parallel act took first answers `conflict`; any other error passes. */
function raced(err: unknown): Result<never> {
  if (err instanceof StorageError && err.code === "unique_violation") return fail("conflict");
  throw err;
}

/**
 * Grants the platform role (spec 26 item 5). The target needs a verified
 * address (`email_unverified`), as `addMember` does, and no active ban
 * (`account_banned`). A user actor does not grant to their own user
 * (`operator_self`) or to a platform operator (`operator_required`). The
 * platform organization must exist (`not_found`): `createAdmin` makes it.
 *
 * One transaction adds the role part to the target's member row of the
 * platform organization. When no row exists, it creates the row with the
 * role alone. The audit row `platform_role_grant` comes last. A target
 * that holds the role already gets no change and the audit row. The member
 * hooks of plan 9d run with `via: "operator"`; a change of the parts of a
 * row runs the role hooks. `by` is null for a secret and the app.
 */
export async function grantPlatformRole(
  config: ResolvedConfig,
  input: PlatformRoleInput,
): Promise<Result<{ auditId: string }>> {
  const p = platformOf(config, input);
  if (!p.ok) return p;
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const user = target.value;
  if (!user.emailVerified) return fail("email_unverified");
  const now = config.clock.now();
  if (activeBan(user, now)) return fail("account_banned");
  const organization = await config.storage.findOne("organization", [
    { field: "slug", op: "eq", value: p.value.slug },
  ]);
  if (!organization) return fail("not_found");
  const drafted = auditDraft(input.actor, {
    action: "platform_role_grant",
    targetUserId: user.id,
    reason: p.value.reason,
    data: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const by = byOf(input.actor);
  try {
    const done = await operatorAct(
      config,
      drafted.value,
      async (tx) => {
        const member = await memberOf(tx, organization.id, user.id);
        const change = await addRolePart(
          config,
          tx,
          p.value,
          { organization, user, role: p.value.role, member, by },
          now,
        );
        if (!change.ok) return change;
        // A new row holds the user row against the account delete (plan 12a
        // Task 11). A change of the parts of a row needs no hold: a deleted
        // row matches zero rows.
        const added = change.value?.kind === "add";
        if (added) await holdUser(config.observe, tx, user.id);
        const written = await writePart(tx, change.value);
        if (!written.ok) return written;
        if (added) await userStays(tx, user.id);
        return ok({ change: change.value });
      },
      {
        committed: ({ change }) =>
          memberChanged(config, publicOrganization(organization), user, by, change),
      },
    );
    if (!done.ok) return done;
    return ok({ auditId: done.value.auditId });
  } catch (err) {
    return raced(err);
  }
}

/**
 * Revokes the platform role (spec 26 item 5). A user actor does not revoke
 * their own role (`operator_self`) or the role of another platform
 * operator (`operator_required`); a secret and the app can.
 *
 * One transaction removes the role part from the target's member row of
 * the platform organization. A row with no part left goes. When the change
 * takes the owner rank from the row, the owner lock of plan 6 guards the
 * write. A revoke that leaves no owner answers `last_owner`. Then
 * `endAllAccessPage` ends every challenge and handoff code of the target,
 * the OAuth refresh tokens and codes, and a page of the sessions. An open
 * session holds power that the role no longer gives (ASVS 5.0.0 8.3.2).
 * The audit row `platform_role_revoke` comes last.
 *
 * The whole invocation fits `OPERATOR_CALL_BUDGET`, the steps after the
 * commit too (rulings 37 and 44 of plan 12f). The sessions that do not fit
 * stay with a pending-end row, and the sweep ends them with `operator`.
 * Until then each operator check reads the role again and refuses them. A
 * target with no role part gets no change and the audit row. When a
 * pending-end row of the target exists, such a revoke ends a page of the
 * sessions again (ruling 45). So a retry does what the first call left.
 * The act also ends the impersonation sessions that the target opened
 * (`endImpersonationsPage`, ruling 31).
 *
 * After the commit, the steps run in the order of ruling 2. First,
 * `session.afterEnd` fires with `operator` for each session. Then the
 * member hooks run with `via: "operator"` (the role hooks for a row that
 * stays). Last, `operatorAct` runs `afterAction` and `endFamilies`. The
 * revoke sends no back-channel logout in its call: the outbox rows are due
 * now, and the sweep sends them (ruling 37 of plan 12f).
 */
export async function revokePlatformRole(
  config: ResolvedConfig,
  input: PlatformRoleInput,
): Promise<Result<{ auditId: string; familyEndFailed?: true }>> {
  const p = platformOf(config, input);
  if (!p.ok) return p;
  // The target and the organization before the act.
  const fixed = TARGET_CALLS[input.actor.kind] + 1;
  const budget = await workBudget(
    config.storage,
    input.actor,
    undefined,
    fixed + REVOKE_WRITE_WORST + DROP_TEAMS_WORST + ACCESS_END_LEAST,
  );
  if (!budget.ok) return budget;
  const target = await targetOf(config, input);
  if (!target.ok) return target;
  const user = target.value;
  const organization = await config.storage.findOne("organization", [
    { field: "slug", op: "eq", value: p.value.slug },
  ]);
  if (!organization) return fail("not_found");
  const now = config.clock.now();
  const drafted = auditDraft(input.actor, {
    action: "platform_role_revoke",
    targetUserId: user.id,
    reason: p.value.reason,
    data: null,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const { o, role } = p.value;
  const by = byOf(input.actor);
  const summary = publicOrganization(organization);
  const hooks = config.hooks.organization;
  const stops = impersonationStops(config, "revoke");
  const done = await operatorAct(
    config,
    drafted.value,
    async (tx, _draft, ends: OperatorActEnds): Promise<Result<{ change: MemberChange }>> => {
      const meter = meterOf(tx, fixed);
      // The user row first (user-hold.ts). An impersonation start holds it
      // too (ruling 42 of plan 12f). So the start sees the role gone, or it
      // commits its start row before `endImpersonationsPage` reads.
      await holdUser(config.observe, tx, user.id);
      meter.step(STEP_WORST.hold);
      // One read takes the locks of the user's sessions and of the
      // impersonation sessions that the user opened. It comes right after
      // the user row, as in the ban and `withRoleLoss` (user-hold.ts). It
      // costs the audit read and the lock read. So no owner lock comes
      // between the two holds.
      const hold = await holdImpersonations(tx, config, user.id, now, true);
      meter.step(2);
      const member = await memberOf(tx, organization.id, user.id);
      meter.step(1);
      if (!member || !holdsRolePart(member.role, role)) {
        // A retry after a revoke that left sessions (ruling 45): the pending-end row names them.
        const pending = await hasPendingEnd(tx, user.id);
        meter.step(1);
        if (pending)
          await endAllAccessPage(
            tx,
            config,
            user.id,
            ends,
            now,
            meter,
            budget.value,
            "operator",
            stops,
          );
        return ok({ change: null });
      }
      const rest = member.role
        .split(",")
        .filter((part) => part !== role)
        .join(",");
      const event = {
        organization: summary,
        member: memberSummary(member, user),
        memberUser: user,
        by,
      };
      const byRole = [
        { field: "id" as const, op: "eq" as const, value: member.id },
        { field: "role" as const, op: "eq" as const, value: member.role },
      ];
      // The role from the read is in the where: a parallel change matches zero rows.
      const write = async (storage: StorageAdapter) => {
        if (rest === "") {
          await runBefore(
            config.observe,
            "organization.beforeRemoveMember",
            hooks.beforeRemoveMember,
            {
              ...event,
              via: "operator",
            },
          );
          const n = await storage.delete("member", byRole);
          // The team rows go with the member row, with no team hook (ruling 16 of plan 12k).
          if (n > 0) await dropMemberTeams(storage, organization.id, user.id);
          return n;
        }
        await runBefore(
          config.observe,
          "organization.beforeUpdateMemberRole",
          hooks.beforeUpdateMemberRole,
          {
            ...event,
            role: rest,
          },
        );
        return storage.update("member", byRole, { role: rest, updatedAt: now });
      };
      const losesOwner =
        isOwner(o, rankOf(o.ranks, member.role)) &&
        (rest === "" || !isOwner(o, rankOf(o.ranks, rest)));
      if (losesOwner) {
        const locked = await ownerLock(tx, o, organization, write, now);
        if (!locked.ok) return locked;
      } else if ((await write(tx)) === 0) return fail("conflict");
      meter.step((losesOwner ? REVOKE_WRITE_WORST : 2) + (rest === "" ? DROP_TEAMS_WORST : 0));
      // The impersonation sessions first, inside the budget (rulings 31 and 44).
      await endImpersonationsPage(
        tx,
        config,
        hold,
        ends.ended ?? null,
        now,
        meter,
        budget.value,
        ACCESS_END_KEEP,
        "operator",
        stops,
      );
      await endAllAccessPage(
        tx,
        config,
        user.id,
        ends,
        now,
        meter,
        budget.value,
        "operator",
        stops,
      );
      const change: MemberChange =
        rest === ""
          ? { kind: "remove", member }
          : {
              kind: "role",
              member: { ...member, role: rest, updatedAt: now },
              previousRole: member.role,
            };
      return ok({ change });
    },
    {
      async committed({ change }, ends) {
        // A retry with no change can end sessions too.
        await sessionsEnded(config, ends.ended, "operator", stops);
        if (change === null) return;
        await memberChanged(config, summary, user, by, change);
      },
      answerFamilyEnd: true,
    },
  );
  if (!done.ok) return done;
  const { auditId, familyEndFailed } = done.value;
  return ok(familyEndFailed ? { auditId, familyEndFailed } : { auditId });
}

/**
 * The worst case of the member write of a revoke in D1 statements, for an
 * adapter with no `statementsSent`. The owner lock reads the owners and
 * updates the organization (2). Then it writes the member row (2), and
 * reads the owners again.
 */
const REVOKE_WRITE_WORST = 6;

/**
 * The worst case of `dropMemberTeams` in D1 statements, for an adapter with
 * no `statementsSent`: the delete of the team rows and the update of the
 * sessions, each with the read for the undo (ruling 16 of plan 12k).
 */
const DROP_TEAMS_WORST = 4;

/**
 * Creates the first operator (spec 26 items 5 and 11). A secret or the app
 * only: a user actor answers `operator_required`. The address goes through
 * `normalizeEmail`, else `invalid_body`. An existing user with an active
 * ban answers `account_banned`.
 *
 * One transaction, through `operatorAct` with the action `create_admin`:
 *
 * 1. The platform organization when no organization holds the slug, with
 *    the slug `organizations.platformOrganization` and the name `appName`.
 * 2. The user when no user holds the address: `emailVerified: false`, no
 *    password, and no `email` identity. `user.beforeCreate` and
 *    `afterCreate` run with `via: "operator"`. The sign-up rule does not
 *    apply: the operator, not a stranger, creates the user.
 * 3. The member row. In a new organization the role is `owner` and the
 *    platform role (plan deviation 8), so the last-owner rule of plan 6
 *    holds. Else the role part goes onto the row, or a new row gets the
 *    role alone, as in `grantPlatformRole`.
 *
 * `created` is true only when the user row is new. The audit row names the
 * user in `targetUserId`, with `data` `{ created, organizationCreated }`.
 * The new operator has no power before the first proof of the mailbox and
 * a second factor (spec 26 item 2). `requireOperatorUser` refuses an
 * unverified address and a user with no factor. A proof of the
 * mailbox claims the address (`claimEmail`), so a stranger who signed up
 * at the address first loses every credential.
 *
 * The reads before the act give the draft its user id. The act reads the
 * organization and the user again. A parallel change answers `conflict`. A
 * unique key that a parallel call took first also answers `conflict`.
 */
export async function createAdmin(
  config: ResolvedConfig,
  input: CreateAdminInput,
): Promise<Result<{ userId: string; created: boolean; auditId: string }>> {
  const p = platformOf(config, input);
  if (!p.ok) return p;
  if (input.actor.kind === "user") return fail("operator_required");
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : null;
  if (email === null) return fail("invalid_body");
  if (input.name !== undefined && (typeof input.name !== "string" || !validUserName(input.name)))
    return fail("invalid_body");
  const { slug, role } = p.value;
  const bySlug = [{ field: "slug" as const, op: "eq" as const, value: slug }];
  const byEmail = [{ field: "email" as const, op: "eq" as const, value: email }];
  const now = config.clock.now();
  const seenOrganization = await config.storage.findOne("organization", bySlug);
  const seenUser = await config.storage.findOne("user", byEmail);
  if (seenUser && activeBan(seenUser, now)) return fail("account_banned");
  const userId = seenUser?.id ?? newId(now);
  const drafted = auditDraft(input.actor, {
    action: "create_admin",
    targetUserId: userId,
    reason: p.value.reason,
    data: { created: seenUser === null, organizationCreated: seenOrganization === null },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  if (!drafted.ok) return drafted;
  const steps = createSteps(config, "operator", { signUpRule: false });
  const hooks = config.hooks.organization;
  try {
    const done = await operatorAct(
      config,
      drafted.value,
      async (tx) => {
        steps.begin();
        const found = await tx.findOne("organization", bySlug);
        const existing = await tx.findOne("user", byEmail);
        if ((found?.id ?? null) !== (seenOrganization?.id ?? null)) return fail("conflict");
        if ((existing?.id ?? null) !== (seenUser?.id ?? null)) return fail("conflict");
        if (existing && activeBan(existing, now)) return fail("account_banned");
        const organization: OrganizationRow = found ?? {
          id: newId(now),
          slug,
          name: config.appName,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        };
        // Every before hook runs before the first write: the D1 undo (plan 9d).
        const user =
          existing ??
          (await steps.user(tx, {
            id: userId,
            email,
            emailVerified: false,
            name: input.name ?? null,
            image: null,
            bannedAt: null,
            banReason: null,
            banUntil: null,
            createdAt: now,
            updatedAt: now,
          }));
        let change: PartChange;
        if (found) {
          const member = await memberOf(tx, organization.id, user.id);
          const added = await addRolePart(
            config,
            tx,
            p.value,
            { organization, user, role, member, by: null },
            now,
          );
          if (!added.ok) return added;
          change = added.value;
        } else {
          const member: MemberRow = {
            id: newId(now),
            organizationId: organization.id,
            userId: user.id,
            role: role === "owner" ? "owner" : `owner,${role}`,
            createdAt: now,
            updatedAt: now,
          };
          await runBefore(config.observe, "organization.beforeAddMember", hooks.beforeAddMember, {
            organization: publicOrganization(organization),
            member: { userId: user.id, role: member.role },
            memberUser: user,
            by: null,
            via: "operator",
            invitation: null,
          });
          change = { kind: "add", member };
        }
        // The hold of the user row comes before the member write, the lock
        // order of `user-hold.ts`. The account delete takes the user row and
        // then the member rows, so the other order can deadlock on Postgres.
        if (existing) await holdUser(config.observe, tx, user.id);
        if (!found) await tx.create("organization", organization);
        if (!existing) await tx.create("user", user);
        const written = await writePart(tx, change);
        if (!written.ok) return written;
        if (existing) await userStays(tx, user.id);
        return ok({ user, created: !existing, organization, change });
      },
      {
        async committed(value) {
          await steps.after(value.user);
          await memberChanged(
            config,
            publicOrganization(value.organization),
            value.user,
            null,
            value.change,
          );
        },
      },
    );
    if (!done.ok) return done;
    return ok({
      userId: done.value.user.id,
      created: done.value.created,
      auditId: done.value.auditId,
    });
  } catch (err) {
    return raced(err);
  }
}
