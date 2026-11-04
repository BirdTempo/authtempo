import { can, type Statements, union } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { organizationChange } from "../observe/events.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { MemberRow, OrganizationRow, SessionRow, UserRow } from "../schema.js";
import { findManyIn, IN_CHUNK } from "../storage/batch.js";
import { meterOf } from "../storage/meter.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { byAddressThenId, type ProofCaller, provedAddress } from "./address.js";
import {
  hookGuard,
  type MemberVia,
  type OrganizationPatch,
  type RemoveVia,
  runAfter,
  runBefore,
  stopWith,
} from "./hooks.js";
import { endImpersonationsPage } from "./operator/access-end.js";
import { type ImpersonationStops, impersonationStops } from "./operator/audit.js";
import { holdsPlatformRole, writesPlatformRole } from "./operator/guards.js";
import { holdImpersonations } from "./operator/impersonation.js";
import { OPERATOR_CALL_BUDGET, STEP_WORST } from "./operator/sessions.js";
import {
  effectiveIn,
  grantCheck,
  type RoleStanding,
  type Standing,
  touchCheck,
} from "./permissions.js";
import {
  isOwner,
  needs,
  normalizeSlug,
  type ResolvedOrganizations,
  ROLE_RE,
  RULE_STATEMENTS,
  rankOf,
  roleAllowedIn,
} from "./ranks.js";
import { ROUNDS } from "./rounds.js";
import { endedList, sessionsEnded } from "./sessions.js";
import { spendSlugRead } from "./slug-check.js";
import { createDefaultTeam, dropMemberTeams, lockOrganization } from "./teams.js";
import { holdSessions, holdUser, userStays } from "./user-hold.js";

export interface Caller {
  user: UserRow;
  /**
   * The caller's session (plan 12p). Each route passes the session it holds,
   * so a session made before the proof of its address writes nothing that
   * needs a verified address. Absent: the user row's rule, as for a caller
   * with no session.
   */
  session?: SessionRow | undefined;
}

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface MemberSummary {
  id: string;
  userId: string;
  role: string;
  /** Null for a member with no address (plan 12i). */
  email: string | null;
  name: string | null;
  createdAt: Date;
}

const NAME_MAX = 120;

/**
 * The organization name rule: 1 to 120 UTF-16 code units, no control
 * character. The name goes into a mail subject; a CR or LF would inject a
 * header. Exported for the importer (plan 9b), so one rule holds for both.
 */
export function validOrganizationName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX && !hasControlChar(name);
}

export function publicOrganization(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function on(config: ResolvedConfig): ResolvedOrganizations | null {
  return config.organizations;
}

/** The caller's membership, the organization, and the caller's rank, or null when the caller is not a member. */
export async function membership(
  config: ResolvedConfig,
  organizationId: string,
  userId: string,
): Promise<{ member: MemberRow; organization: OrganizationRow; rank: number } | null> {
  const o = on(config);
  if (!o) return null;
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return null;
  const member = await config.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
  if (!member) return null;
  return { member, organization, rank: rankOf(o.ranks, member.role) };
}

/**
 * The caller's standing for a statement set (plan 12k: `RULE_STATEMENTS` of
 * each plan 6 rule). A missing id answers not_found and a non-member
 * forbidden_rank. Ids are ULIDs and slugs are public, so existence is not a
 * secret; the distinct codes let a client tell a dead link from a missing
 * right. `granted` is the caller's effective set in the organization.
 * `reads` is the count of role row reads of `effectiveIn` (0 or 1).
 */
export async function standing(
  config: ResolvedConfig,
  user: UserRow,
  organizationId: string,
  wanted: Statements | null,
): Promise<
  Result<{
    member: MemberRow;
    organization: OrganizationRow;
    rank: number;
    granted: Statements;
    reads: number;
  }>
> {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return fail("not_found");
  const m = await membership(config, organizationId, user.id);
  if (!m) return fail("forbidden_rank");
  // The rank of a dynamic role counts too (plan 12k Task 4), so a grant compares like with like.
  const { rank, granted, reads } = await effectiveIn(
    config,
    config.storage,
    organizationId,
    m.member.role,
  );
  // A null set needs membership only: a member may leave at any rank, rank 0 included.
  if (wanted !== null && !can(granted, wanted)) return fail("forbidden_rank");
  return ok({ ...m, rank, granted, reads });
}

/**
 * A write of an organization or a team needs a verified address, and a
 * session made after its proof when the caller has one (plan 12p).
 */
export function verified(caller: ProofCaller): Result<true> {
  return provedAddress(caller) ? ok(true) : fail("email_unverified");
}

/** A dynamic role never has the owner rank (Task 4), so the last-owner rule reads the config only. */
async function ownerCount(
  storage: StorageAdapter,
  o: ResolvedOrganizations,
  organizationId: string,
): Promise<number> {
  const members = await storage.findMany("member", [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
  const ownerRank = o.ranks.owner ?? Number.POSITIVE_INFINITY;
  return members.filter((m) => rankOf(o.ranks, m.role) >= ownerRank).length;
}

// The owner rule lives in ranks.ts, so the config reads it too (plan 12d Task 9b).
export { isOwner };

/**
 * The owner lock in the caller's transaction (plan 6): the owner count, the
 * lock, the write, and the recount. `organization` is the row from the
 * standing read. `write` returns the number of member rows it changed.
 * `ownerWrite` runs it in its own transaction. An operator act (plan 12f)
 * runs it in the act's transaction, so the lock and the act commit together.
 *
 * The port has no row lock. The conditional update of updatedAt is an
 * optimistic lock: on Postgres the second of two concurrent owner writes
 * re-checks the WHERE after the first commit, matches zero rows, and answers
 * conflict. Memory runs one transaction at a time.
 *
 * D1 transactions are not isolated: a second request can read the stamp this
 * transaction wrote and pass the lock before this transaction deletes its
 * owner. The recount after the write catches that case. If no owner remains,
 * the throw of `conflict` rolls this transaction back, and the later of the
 * two racers answers conflict. The caller runs the lock in `hookGuard`, which
 * answers the throw outside the transaction.
 *
 * A refusal before the first write returns a value and does not throw: no
 * write has run at that point, so the commit changes nothing. A hold that
 * the caller took before this lock writes no new value, so a refusal after
 * it still changes nothing (`ownerWrite`, ruling 43).
 */
export async function ownerLock(
  tx: StorageAdapter,
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  write: (tx: StorageAdapter) => Promise<number>,
  now: Date,
): Promise<Result<true>> {
  const seen = organization.updatedAt;
  if ((await ownerCount(tx, o, organization.id)) <= 1) return fail("last_owner");
  // One millisecond past the read, so the stamp changes even when the clock has not moved.
  const stamp = new Date(Math.max(now.getTime(), seen.getTime() + 1));
  const n = await tx.update(
    "organization",
    [
      { field: "id", op: "eq", value: organization.id },
      { field: "updatedAt", op: "eq", value: seen },
    ],
    { updatedAt: stamp },
  );
  if (n === 0) return fail("conflict");
  // Zero rows: the member's role changed after the standing read. The lock update must roll back.
  if ((await write(tx)) === 0) stopWith("conflict");
  if ((await ownerCount(tx, o, organization.id)) < 1) stopWith("conflict");
  return ok(true);
}

/**
 * A write that can remove an owner: `ownerLock` in its own transaction. The
 * caller runs it in `hookGuard`. `hold` is a user to hold first, before the
 * lock of the organization row, in the lock order of user-hold.ts (ruling 43
 * of plan 12k). The locks of that user's sessions come next (ruling 49): a
 * removal writes them after the member and team member deletes. The hold
 * writes no new value, so a refusal after it still changes nothing.
 */
async function ownerWrite(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  write: (tx: StorageAdapter) => Promise<number>,
  loss: RoleLoss | null = null,
  hold: string | null = null,
): Promise<Result<true>> {
  const now = config.clock.now();
  return config.storage.transaction((tx) =>
    withRoleLoss(
      tx,
      loss,
      now,
      async (t) => {
        // With a loss, withRoleLoss holds the same user and sessions first (the removed member).
        if (hold !== null && hold !== loss?.userId) {
          await holdUser(config.observe, t, hold);
          await holdSessions(t, hold);
        }
        return ownerLock(t, o, organization, write, now);
      },
      (r) => r.ok,
    ),
  );
}

/**
 * A member write that takes the platform role from `userId` (ruling 42 I1
 * of plan 12f). `ended` collects the ended sessions for `session.afterEnd`.
 * `before` is the count of the calls of the invocation before the
 * transaction (ruling 63).
 */
interface RoleLoss {
  config: ResolvedConfig;
  userId: string;
  ended: SessionRow[] | undefined;
  /** The count of the sessions that the page ended, for the event session.end (plan 12h Task 5). */
  count: number;
  stops: ImpersonationStops | null;
  before: number;
}

/**
 * The fixed calls of a member write before its transaction, at the worst
 * (ruling 63 of plan 12f). Through the route: the impersonation step of
 * the router (1) and `resolveSession` (5, with the pending-end read of
 * ruling 50 and the session-cap read of ruling 44 of plan 12d). The member
 * routes have no limiter. Then the standing of the caller (3): the
 * organization, and the organization and member row of `membership`. Then
 * the target's `membership` (2), and its user (1). The sum is 12. The
 * reads of the role rows (plan 12k) and the ready check of the storage
 * come on top. `roleLossOf` takes the count of the role reads that ran.
 * The D1 test `operator-loss-budget.test.ts` counts the whole invocation
 * on the binding. At 10, a removal with a due refresh sent 51 queries, and
 * 52 with `sso.saml` on (run of 2026-10-22). So 10 left out the refresh
 * and the session-cap read, and 12 holds them. A log of the statements of
 * that removal on 2026-10-24 showed these 12 before the user hold, after
 * the ready check (ruling 74 item 4 of plan 12d).
 */
const MEMBER_WRITE_CALLS_BEFORE = 12;

/** The worst case of the member write in `withRoleLoss`: the owner lock, the write, and the recount. */
const MEMBER_WRITE_WORST = 5;

/**
 * The loss of a member write, or null when the write keeps the platform
 * role. `roleReads` is the count of the role row reads of `effectiveIn`
 * that ran before the transaction (ruling 48 of plan 12k). They are the
 * reads of the caller's standing, the granted role, and the target's role.
 */
async function roleLossOf(
  config: ResolvedConfig,
  organization: OrganizationRow,
  member: MemberRow,
  roleReads: number,
): Promise<RoleLoss | null> {
  if (!writesPlatformRole(config, organization, member.role)) return null;
  return {
    config,
    userId: member.userId,
    ended: endedList(config),
    count: 0,
    stops: impersonationStops(config, "role_loss"),
    before:
      MEMBER_WRITE_CALLS_BEFORE + roleReads + ((await config.storage.readyStatements?.()) ?? 1),
  };
}

/**
 * Runs `work` in `tx`. With a loss, the member's user row comes first
 * (user-hold.ts), then the locks of the member's sessions and impersonation
 * rows in one read (`holdImpersonations`). An impersonation start holds the
 * same user row, so it sees the role gone or commits first. When `wrote`
 * says that the write took effect, a page of the impersonation sessions
 * that the member opened ends in the same transaction. The page fits
 * `OPERATOR_CALL_BUDGET` with the calls before it. The rest stay with a
 * pending-end row, and the sweep ends them (ruling 63 of plan 12f). Until
 * then the doors refuse them (`impersonationLoss`). No logout goes inline
 * (ruling 37): an impersonation session has no client link.
 */
async function withRoleLoss<T>(
  tx: StorageAdapter,
  loss: RoleLoss | null,
  now: Date,
  work: (tx: StorageAdapter) => Promise<T>,
  wrote: (value: T) => boolean,
): Promise<T> {
  if (!loss) return work(tx);
  loss.count = 0;
  const meter = meterOf(tx, loss.before);
  await holdUser(loss.config.observe, tx, loss.userId);
  meter.step(STEP_WORST.hold);
  const hold = await holdImpersonations(tx, loss.config, loss.userId, now, true);
  // The audit read and the lock read.
  meter.step(2);
  const value = await work(tx);
  meter.step(MEMBER_WRITE_WORST);
  // No call after the commit reads the storage, so the page keeps none.
  if (wrote(value))
    loss.count = (
      await endImpersonationsPage(
        tx,
        loss.config,
        hold,
        loss.ended ?? null,
        now,
        meter,
        OPERATOR_CALL_BUDGET,
        0,
        "impersonation_end",
        loss.stops,
      )
    ).ended;
  return value;
}

export async function createOrganization(
  config: ResolvedConfig,
  input: Caller & { slug: string; name: string; metadata?: Record<string, unknown> | null },
): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input);
  if (!v.ok) return v;
  const slug = normalizeSlug(input.slug);
  if (slug === null || !validOrganizationName(input.name)) return fail("invalid_body");
  if (o.reservedSlugs.has(slug)) return fail("slug_reserved");
  // The slug read below answers in use or free, as the slug check does, so it spends the same key first.
  if (!(await spendSlugRead(config, input.user.id))) return fail("rate_limited");
  const now = config.clock.now();
  const organization: OrganizationRow = {
    id: newId(now),
    slug,
    name: input.name,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const member: MemberRow = {
    id: newId(now),
    organizationId: organization.id,
    userId: input.user.id,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  };
  const summary = publicOrganization(organization);
  const owner: MemberSummary = {
    id: member.id,
    userId: member.userId,
    role: member.role,
    email: input.user.email,
    name: input.user.name,
    createdAt: member.createdAt,
  };
  const hooks = config.hooks.organization;
  const limit = o.limits.perUser;
  try {
    const written = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<true>> => {
        // First, in the lock order of user-hold.ts. A member row of a deleted user would count as
        // an owner (plan 12a Task 11). The hold also makes a second create of the user wait here,
        // so it counts the first one's member row (ruling 45 of plan 12k). It writes no new value.
        await holdUser(config.observe, tx, input.user.id);
        // The count and the slug read run before any other write, so a refusal changes nothing.
        // perUser counts the user's member rows at any rank, as Better Auth's numeric limit does.
        if (limit !== null) {
          const held = await tx.findMany(
            "member",
            [{ field: "userId", op: "eq", value: input.user.id }],
            { limit },
          );
          if (held.length >= limit) return fail("organization_limit");
        }
        // A hook must not run for a taken slug. The unique key stays the guard for a race.
        if (await tx.findOne("organization", [{ field: "slug", op: "eq", value: slug }]))
          return fail("slug_taken");
        await runBefore(config.observe, "organization.beforeCreate", hooks.beforeCreate, {
          organization: summary,
          user: input.user,
        });
        await runBefore(config.observe, "organization.beforeAddMember", hooks.beforeAddMember, {
          organization: summary,
          member: { userId: input.user.id, role: member.role },
          memberUser: input.user,
          by: input.user,
          via: "create",
          invitation: null,
        });
        await tx.create("organization", organization);
        await tx.create("member", member);
        // Plan 12k: the default team is part of the create, so it fires no team hook.
        if (o.teams?.defaultTeam)
          await createDefaultTeam(tx, organization.id, organization.name, input.user.id, now);
        await userStays(tx, input.user.id);
        return ok(true);
      }),
    );
    if (!written.ok) return written;
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation") return fail("slug_taken");
    throw err;
  }
  // Better Auth's order: the member's after hook, then the organization's.
  await runAfter(
    config.observe,
    "organization.afterAddMember",
    hooks.afterAddMember,
    {
      organization: summary,
      member: owner,
      memberUser: input.user,
      by: input.user,
      via: "create",
      invitation: null,
    },
    member.id,
  );
  config.observe.emit(organizationChange("afterAddMember", summary.id));
  await runAfter(
    config.observe,
    "organization.afterCreate",
    hooks.afterCreate,
    { organization: summary, member: owner, user: input.user },
    organization.id,
  );
  config.observe.emit(organizationChange("afterCreate", summary.id));
  return ok({ organization: summary, member: owner });
}

export async function listOrganizations(
  config: ResolvedConfig,
  input: Caller,
): Promise<Result<{ organization: OrganizationSummary; role: string }[]>> {
  if (!on(config)) return fail("not_found");
  const members = await config.storage.findMany("member", [
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  if (members.length === 0) return ok([]);
  const orgs = await findManyIn(
    config.storage,
    "organization",
    "id",
    members.map((m) => m.organizationId),
  );
  const byId = new Map(orgs.map((org) => [org.id, org]));
  const out = members
    .flatMap((m) => {
      const org = byId.get(m.organizationId);
      return org ? [{ organization: publicOrganization(org), role: m.role }] : [];
    })
    .sort(
      (a, b) =>
        a.organization.name.localeCompare(b.organization.name) ||
        (a.organization.id < b.organization.id ? -1 : 1),
    );
  return ok(out);
}

export async function updateOrganization(
  config: ResolvedConfig,
  input: Caller & {
    organizationId: string;
    name?: string;
    slug?: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<Result<OrganizationSummary>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.update);
  if (!s.ok) return s;
  const data: OrganizationPatch = {};
  if (input.name !== undefined) {
    if (!validOrganizationName(input.name)) return fail("invalid_body");
    data.name = input.name;
  }
  if (input.metadata !== undefined) data.metadata = input.metadata;
  if (input.slug !== undefined) {
    if (s.value.rank < needs(o, "slugChange")) return fail("forbidden_rank");
    // The platform role is valid in the platform organization only, and the slug is reserved, so a rename could never come back.
    if (s.value.organization.slug === o.platformOrganization) return fail("slug_reserved");
    const slug = normalizeSlug(input.slug);
    if (slug === null) return fail("invalid_body");
    if (o.reservedSlugs.has(slug)) return fail("slug_reserved");
    data.slug = slug;
  }
  if (Object.keys(data).length === 0) return ok(publicOrganization(s.value.organization));
  // A new slug is read below, so the rename spends the key of the slug check first.
  if (data.slug !== undefined && data.slug !== s.value.organization.slug) {
    if (!(await spendSlugRead(config, input.user.id))) return fail("rate_limited");
  }
  const now = config.clock.now();
  const hooks = config.hooks.organization;
  const current = publicOrganization(s.value.organization);
  // The caller's own member row: Better Auth's update hooks name it.
  const callerMember: MemberSummary = {
    id: s.value.member.id,
    userId: input.user.id,
    role: s.value.member.role,
    email: input.user.email,
    name: input.user.name,
    createdAt: s.value.member.createdAt,
  };
  const newSlug = data.slug;
  try {
    const written = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<true>> => {
        // A hook must not run for a taken slug. The unique key stays the guard for a race.
        if (
          newSlug !== undefined &&
          newSlug !== s.value.organization.slug &&
          (await tx.findOne("organization", [{ field: "slug", op: "eq", value: newSlug }]))
        )
          return fail("slug_taken");
        await runBefore(config.observe, "organization.beforeUpdate", hooks.beforeUpdate, {
          organization: current,
          patch: data,
          member: callerMember,
          user: input.user,
        });
        await tx.update("organization", [{ field: "id", op: "eq", value: input.organizationId }], {
          ...data,
          updatedAt: now,
        });
        return ok(true);
      }),
    );
    if (!written.ok) return written;
  } catch (err) {
    if (err instanceof StorageError && err.code === "unique_violation") return fail("slug_taken");
    throw err;
  }
  const stored = publicOrganization({ ...s.value.organization, ...data, updatedAt: now });
  await runAfter(
    config.observe,
    "organization.afterUpdate",
    hooks.afterUpdate,
    { organization: stored, member: callerMember, user: input.user },
    stored.id,
  );
  config.observe.emit(organizationChange("afterUpdate", stored.id));
  return ok(stored);
}

export async function deleteOrganization(
  config: ResolvedConfig,
  input: Caller & { organizationId: string },
): Promise<Result<{ ok: true }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.delete);
  if (!s.ok) return s;
  // The app seeds the platform organization; the engine never deletes it, because no route could create it again.
  if (s.value.organization.slug === o.platformOrganization) return fail("slug_reserved");
  const id = input.organizationId;
  const hooks = config.hooks.organization;
  const organization = publicOrganization(s.value.organization);
  const byOrganization: Where<"session">[] = [
    { field: "activeOrganizationId", op: "eq", value: id },
  ];
  // ok(false): a set moved a session into the organization after the lock read. The next round
  // locks it.
  let deleted: Result<boolean> = ok(false);
  for (let round = 0; round < ROUNDS && deleted.ok && !deleted.value; round++)
    deleted = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<boolean>> => {
        // The sessions that act in the organization come before its row, in the order of
        // user-hold.ts (rulings 49 and 50 of plan 12k). With row locks, the ids are read
        // first and locked by id. The delete clears their active organization last.
        const locks = tx.lockInOrder !== undefined;
        // The scimGroup rows come first, in the order of user-hold.ts (ruling 74 of plan 12d).
        // A SCIM group write holds its group row before every other lock.
        await tx.lockInOrder?.("scimGroup", [{ field: "organizationId", op: "eq", value: id }]);
        const ids = locks ? (await tx.findMany("session", byOrganization)).map((x) => x.id) : [];
        await tx.lockInOrder?.("session", [{ field: "id", op: "in", value: ids }]);
        // The scimUser rows come before the organization row (ruling 74 M3 of plan 12d).
        await tx.lockInOrder?.("scimUser", [{ field: "organizationId", op: "eq", value: id }]);
        if (locks) {
          // After the organization lock, no set moves a session into the organization: a set
          // takes the same lock. A session that a set moved in after the read above has no
          // lock here, so this round writes nothing.
          if (!(await lockOrganization(tx, s.value.organization))) return fail("not_found");
          if ((await tx.findMany("session", byOrganization)).some((x) => !ids.includes(x.id)))
            return ok(false);
        }
        await runBefore(config.observe, "organization.beforeDelete", hooks.beforeDelete, {
          organization,
          user: input.user,
        });
        await deleteOrganizationRows(tx, id);
        return ok(true);
      }),
    );
  if (!deleted.ok) return deleted;
  // Each round lost to a set: the person tries again.
  if (!deleted.value) return fail("conflict");
  // The member and invitation rows go with the organization and fire no member hook, as in Better Auth.
  await runAfter(
    config.observe,
    "organization.afterDelete",
    hooks.afterDelete,
    { organization, user: input.user },
    id,
  );
  config.observe.emit(organizationChange("afterDelete", organization.id));
  return ok({ ok: true });
}

/**
 * The rows of one organization, in the caller's transaction. One copy of
 * the order for the organization delete, the account delete, and the sweep
 * (plan 12a, ruling 78 of plan 12d).
 *
 * The order closes the gaps of the flows in flight. The organization row
 * goes first (ruling 43 of plan 12k). A token create, a team create, and a
 * role create hold that row (`lockOrganization`). So do a member add and an
 * accept under `membersPerOrganization`, and an invite under
 * `pendingInvitationsPerOrganization` (ruling 45). On Postgres such a flow
 * commits first, and the deletes below see its rows. A flow that starts
 * later finds no organization. The team rows go next, before the team
 * member rows. A team member add or an accept holds its team row until its
 * commit, so the team member delete below sees its row.
 *
 * The member rows go before the team member rows (ruling 44 of plan 12k).
 * A member removal and the account delete delete the member row first, and
 * then its team rows. This delete takes them in the same order. So on
 * Postgres it waits for the member row, and no deadlock forms.
 *
 * Then the gap of an accept in flight (plan 12a Task 11). On Postgres an
 * accept holds its invitation row until its commit. So this delete waits,
 * and the member read below sees that member. An accept that starts later
 * finds no invitation. The organization row goes before the members: D1 has
 * no lock, and an accept reads the organization after its member insert.
 * The account delete takes the member rows in its act and checks that no
 * other member joined (`deleteAccountRows` in account-delete.ts).
 */
export async function deleteOrganizationRows(tx: StorageAdapter, id: string): Promise<void> {
  await deleteOrganizationsRows(tx, [id], ORGANIZATION_DELETE_GROUPS);
}

/**
 * The most SCIM Groups that one organization delete removes (ruling 74 of
 * plan 12d): ten deletes of IN_CHUNK group ids. On the D1 binding the route
 * sent 23 queries with 50 groups, 20 of them with no group (2026-10-24). So
 * ten deletes fit the 50 queries of D1 Free with room for a due refresh.
 */
export const ORGANIZATION_DELETE_GROUPS = 10 * IN_CHUNK;

/**
 * `deleteOrganizationRows` for many organizations at once (ruling 30 of
 * plan 12d). Each model is one statement with `in` over the ids, so the
 * cost does not grow with the count of organizations. The order of the
 * statements is the order above: `deleteOrganizationsHead`, then
 * `deleteOrganizationsRest`.
 */
export async function deleteOrganizationsRows(
  tx: StorageAdapter,
  ids: readonly string[],
  groupsMax: number,
): Promise<void> {
  if (ids.length === 0) return;
  const list = organizationList(ids);
  // Ruling 74 of plan 12d (P9 of ruling 53): the SCIM Groups go with their organizations. A
  // scimGroupMember row names its group, not the organization, so one read takes the group
  // ids, before any write. One delete binds at most IN_CHUNK ids on D1, and the caller gives
  // the count of groups that its call budget holds (`groupsMax`). More groups answer
  // delete_too_large. The caller locked the scimGroup rows first, in the order of user-hold.ts.
  const groups = await organizationGroups(tx, list, groupsMax + 1);
  if (groups.length > groupsMax) stopWith("delete_too_large");
  await deleteOrganizationsHead(tx, list);
  await deleteOrganizationsRest(tx, list, groups);
}

/**
 * The ids of one set-based delete, in id order. They fit one chunk of
 * `IN_CHUNK`: D1 binds at most 100 parameters. A longer list throws, so a
 * caller refuses it first (`delete_too_large`).
 */
export function organizationList(ids: readonly string[]): string[] {
  if (ids.length > IN_CHUNK) throw new StorageError("invalid_argument", "organization", ["id"]);
  return [...ids].sort();
}

/** The ids of at most `limit` SCIM Groups of the organizations of `list`. */
export async function organizationGroups(
  tx: StorageAdapter,
  list: string[],
  limit: number,
): Promise<string[]> {
  return (
    await tx.findMany("scimGroup", [{ field: "organizationId", op: "in", value: list }], { limit })
  ).map((g) => g.id);
}

/**
 * The rows of the organizations of `list` that give access or hold a claim
 * (ruling 78 of plan 12d): the organization rows, then the connection, the
 * domain, and the SCIM token rows. The organization rows lock first, in id
 * order (`lockInOrder`), in the step of the organization row. The account
 * delete takes these rows and the member rows in its act. A flow that comes
 * later finds no organization, no domain claim, and no SCIM token.
 * `locked` is true when the caller took the scimUser and organization locks
 * already (the account delete on a store whose user delete cascades).
 */
export async function deleteOrganizationsHead(
  tx: StorageAdapter,
  list: string[],
  locked = false,
): Promise<void> {
  // The scimUser rows come before the organization row (ruling 74 M3): a SCIM deactivate holds
  // its scimUser row and then takes the organization lock. On Postgres this lock costs one
  // statement; D1 has no row lock.
  if (!locked) {
    await tx.lockInOrder?.("scimUser", [{ field: "organizationId", op: "in", value: list }]);
    await tx.lockInOrder?.("organization", [{ field: "id", op: "in", value: list }]);
  }
  await tx.delete("organization", [{ field: "id", op: "in", value: list }]);
  // Plan 12d (ruling 28): the SSO and SCIM rows go in the step of the
  // organization row. A kept domain row would hold its claim forever, so no
  // other organization could verify the domain. The three models are no
  // kind of user-hold.ts, so the lock order does not change. The connection
  // rows go before the domain rows, the order of `lockConnection` in
  // sso/domains.ts (ruling 35). The other order deadlocks with a domain update.
  await tx.delete("ssoConnection", [{ field: "organizationId", op: "in", value: list }]);
  await tx.delete("ssoDomain", [{ field: "organizationId", op: "in", value: list }]);
  await tx.delete("scimToken", [{ field: "organizationId", op: "in", value: list }]);
}

/**
 * The rows of the organizations of `list` that only their organization
 * reaches (ruling 78 of plan 12d), after `deleteOrganizationsHead`. The
 * organization delete runs it in its act. The account delete leaves it to
 * the sweep (organization-rest.ts): each read of these rows needs its
 * organization row, or a member row of the organization, which the act
 * deleted. `groups` names the SCIM Groups that go, at most `IN_CHUNK` in
 * each delete of their member rows.
 */
export async function deleteOrganizationsRest(
  tx: StorageAdapter,
  list: string[],
  groups: readonly string[],
): Promise<void> {
  // Plan 12d Task 10: the SCIM view of the staff is personal data of the organization.
  await tx.delete("scimUser", [{ field: "organizationId", op: "in", value: list }]);
  // Plan 12k: the teams go before their rows, and fire no team hook.
  await tx.delete("team", [{ field: "organizationId", op: "in", value: list }]);
  await tx.delete("invitation", [{ field: "organizationId", op: "in", value: list }]);
  // The tokens and the role rows of the organization have no use without it (plan 12k).
  await tx.delete("organizationToken", [{ field: "organizationId", op: "in", value: list }]);
  await tx.delete("organizationRole", [{ field: "organizationId", op: "in", value: list }]);
  // The members go before their team rows, in the order of a member removal (ruling 44).
  await tx.delete("member", [{ field: "organizationId", op: "in", value: list }]);
  // The scimGroupMember rows come after the member rows, as in a group write (ruling 59 M1).
  for (let i = 0; i < groups.length; i += IN_CHUNK)
    await tx.delete("scimGroupMember", [
      { field: "groupId", op: "in", value: groups.slice(i, i + IN_CHUNK) },
    ]);
  if (groups.length > 0)
    await tx.delete("scimGroup", [{ field: "organizationId", op: "in", value: list }]);
  await tx.delete("teamMember", [{ field: "organizationId", op: "in", value: list }]);
  // A session that points at a deleted organization would make every later rank check read a missing row.
  // Its active team is a team of that organization, so it goes in the same write.
  await tx.update("session", [{ field: "activeOrganizationId", op: "in", value: list }], {
    activeOrganizationId: null,
    activeTeamId: null,
  });
}

/** What an account delete does to the organizations of the user (plan 12a). */
export interface AccountOrganizations {
  /** The user is the only member: the organization goes with the account. */
  going: OrganizationRow[];
  /**
   * The user is an owner, and another owner stays. The member row goes. The
   * delete takes the owner lock of `ownerWrite` on each, so a parallel owner
   * removal cannot leave the organization with no owner.
   */
  owned: OrganizationRow[];
}

/**
 * The organization rule of an account delete (plan 12a, owner decision 3).
 * An organization where the user is the only member goes with the account.
 * The last owner of an organization with other members answers
 * `sole_owner`: the person makes another member an owner first. The
 * platform organization never goes, because no route can create it again.
 * So its last owner answers `sole_owner`, also as its only member. Any other
 * membership goes with no check. It reads through `storage`, the delete's
 * transaction, after the lock of the user row.
 *
 * With `refusePlatform`, a user who holds the platform role answers
 * `operator_required` before any other answer (ruling 5 of plan 12f2,
 * L1). A user actor does not delete a platform operator. The rule reads
 * the member rows and the organizations anyway, so the check costs no
 * call. It reads them after the user hold. The grant and a role change
 * that add the platform role part hold the user row first too (ruling 6
 * of plan 12f2), so the two run one at a time on Postgres and MySQL. D1
 * has no lock: a grant that lands after this read and before the member
 * delete loses its row with the account.
 */
export async function organizationsOfDelete(
  config: ResolvedConfig,
  storage: StorageAdapter,
  userId: string,
  refusePlatform = false,
): Promise<Result<AccountOrganizations>> {
  const plan: AccountOrganizations = { going: [], owned: [] };
  const o = on(config);
  // With organizations off, the engine has no ranks. The member rows still go.
  if (!o) return ok(plan);
  // Three reads for up to IN_CHUNK memberships (ruling 30 of plan 12d): the
  // memberships, their organizations, and the members of those. The last
  // two read in chunks of IN_CHUNK, so each further IN_CHUNK adds 2.
  const mine = await storage.findMany("member", [{ field: "userId", op: "eq", value: userId }]);
  if (mine.length === 0) return ok(plan);
  const organizations = new Map(
    (
      await findManyIn(
        storage,
        "organization",
        "id",
        mine.map((m) => m.organizationId),
      )
    ).map((x) => [x.id, x]),
  );
  if (
    refusePlatform &&
    mine.some((m) => {
      const organization = organizations.get(m.organizationId);
      return (
        organization?.slug === o.platformOrganization &&
        holdsPlatformRole(config, organization.id, m)
      );
    })
  )
    return fail("operator_required");
  const all = await findManyIn(storage, "member", "organizationId", [...organizations.keys()]);
  for (const m of mine) {
    const organization = organizations.get(m.organizationId);
    if (!organization) continue;
    const members = all.filter((x) => x.organizationId === organization.id);
    const platform = organization.slug === o.platformOrganization;
    if (!platform && members.every((x) => x.userId === userId)) {
      plan.going.push(organization);
      continue;
    }
    if (!isOwner(o, rankOf(o.ranks, m.role))) continue;
    const owners = members.filter((x) => isOwner(o, rankOf(o.ranks, x.role))).length;
    if (owners <= 1) return fail("sole_owner");
    plan.owned.push(organization);
  }
  // The solo organizations go in one set-based delete, and its ids fit one
  // chunk of IN_CHUNK (ruling 30 of plan 12d).
  if (plan.going.length > IN_CHUNK) return fail("delete_too_large");
  plan.going.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // One lock order for every delete (review m1): two co-owners of two
  // organizations who delete at once would else wait on each other, and
  // Postgres would abort one with a deadlock in place of `conflict`.
  plan.owned.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok(plan);
}

/** The number of owners of one organization, read through `storage` (the account delete's recount). */
export async function ownersOf(
  config: ResolvedConfig,
  storage: StorageAdapter,
  organizationId: string,
): Promise<number> {
  const o = on(config);
  return o ? ownerCount(storage, o, organizationId) : 0;
}

async function summaries(config: ResolvedConfig, members: MemberRow[]): Promise<MemberSummary[]> {
  const users = await findManyIn(
    config.storage,
    "user",
    "id",
    members.map((m) => m.userId),
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  return members
    .flatMap((m) => {
      const u = byId.get(m.userId);
      return u
        ? [
            {
              id: m.id,
              userId: m.userId,
              role: m.role,
              email: u.email,
              name: u.name,
              createdAt: m.createdAt,
            },
          ]
        : [];
    })
    .sort(byAddressThenId);
}

export async function listMembers(
  config: ResolvedConfig,
  input: Caller & { organizationId: string },
): Promise<Result<MemberSummary[]>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.members);
  if (!s.ok) return s;
  const members = await config.storage.findMany("member", [
    { field: "organizationId", op: "eq", value: input.organizationId },
  ]);
  return ok(await summaries(config, members));
}

/**
 * The role is well-formed, allowed in this organization, and passes
 * `grantCheck`. So its rank is at most the caller's, and its statements are a
 * subset of the caller's. The answer is the role's standing. Exported for
 * the invite and the accept, so one rule holds for every grant.
 */
export async function grantable(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  caller: Standing,
  role: string,
): Promise<Result<RoleStanding>> {
  if (!ROLE_RE.test(role) || !roleAllowedIn(o, role, organization.slug))
    return fail("invalid_body");
  const target = await effectiveIn(config, config.storage, organization.id, role);
  // An unknown role ranks 0 and would be a silent no-rights member; refuse it with the same code as an escalation, so the caller learns nothing about the table.
  if (target.rank === 0 || !grantCheck(caller, target)) return fail("forbidden_rank");
  // With dynamic roles on, a part that no table names could get rights later from a create of that name (ruling 24 M1).
  if (o.dynamicRoles !== null && target.unnamed > 0) return fail("forbidden_rank");
  return ok(target);
}

export async function addMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string; role: string },
): Promise<Result<MemberSummary>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.addMember);
  if (!s.ok) return s;
  const g = await grantable(config, o, s.value.organization, s.value, input.role);
  if (!g.ok) return g;
  const target = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!target) return fail("not_found");
  if (!target.emailVerified) return fail("email_unverified");
  const now = config.clock.now();
  const member: MemberRow = {
    id: newId(now),
    organizationId: input.organizationId,
    userId: target.id,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
  const organization = publicOrganization(s.value.organization);
  try {
    const written = await hookGuard(() =>
      config.storage.transaction((tx) =>
        addMemberIn(config, tx, o, {
          organization: s.value.organization,
          member,
          user: target,
          by: input.user,
          via: "add",
        }),
      ),
    );
    if (!written.ok) return written;
  } catch (err) {
    if (err instanceof StorageError && err.code === "unique_violation")
      return fail("already_member");
    throw err;
  }
  const added: MemberSummary = {
    id: member.id,
    userId: target.id,
    role: member.role,
    email: target.email,
    name: target.name,
    createdAt: now,
  };
  await runAfter(
    config.observe,
    "organization.afterAddMember",
    config.hooks.organization.afterAddMember,
    {
      organization,
      member: added,
      memberUser: target,
      by: input.user,
      via: "add",
      invitation: null,
    },
    member.id,
  );
  config.observe.emit(organizationChange("afterAddMember", organization.id));
  return ok(added);
}

/** The input of a member add in the caller's transaction. */
interface MemberAdd {
  organization: OrganizationRow;
  member: MemberRow;
  user: UserRow;
  by: UserRow | null;
  via: MemberVia;
}

/** True when the user holds a member row of the organization. */
export async function holdsMember(
  tx: StorageAdapter,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const row = await tx.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
  return row !== null;
}

/** True when the organization holds `membersPerOrganization` member rows or more. */
export async function atMemberLimit(
  tx: StorageAdapter,
  o: ResolvedOrganizations,
  organizationId: string,
): Promise<boolean> {
  const limit = o.limits.membersPerOrganization;
  if (limit === null) return false;
  const held = await tx.findMany(
    "member",
    [{ field: "organizationId", op: "eq", value: organizationId }],
    { limit },
  );
  return held.length >= limit;
}

/**
 * The member add in the caller's transaction (ruling 25 N3 of plan 12d).
 * `addMember` calls it after its standing check, and an SSO sign-in calls it
 * with no user caller (`by` null). It holds the added user, then, with
 * `membersPerOrganization`, the organization row before its count: the lock
 * order of user-hold.ts. Then the before hook and the row. A member row
 * that exists answers `already_member` and writes nothing. The caller runs
 * `afterAddMember` after its commit, and maps a `unique_violation`.
 *
 * With `checked`, the caller ran the member read, the count, and the hook before
 * its first write (ruling 41 of plan 12d). The add then runs no hook. It
 * reads the row and the count again after the locks, because a parallel add
 * can come between.
 */
export async function addMemberIn(
  config: ResolvedConfig,
  tx: StorageAdapter,
  o: ResolvedOrganizations,
  input: MemberAdd,
  checked = false,
): Promise<Result<true>> {
  const { member, user } = input;
  // The added user, then the organization row, in the lock order of user-hold.ts. A member
  // row of a deleted user would count as an owner (plan 12a Task 11). The hold writes no new
  // value, so a refusal below changes nothing.
  await holdUser(config.observe, tx, user.id);
  // The lock of the count (ruling 45 of plan 12k). A second add or accept waits here for this
  // commit, and then counts its member row. A gone organization answers not_found.
  if (o.limits.membersPerOrganization !== null && !(await lockOrganization(tx, input.organization)))
    return fail("not_found");
  // A no-op add runs no hook. The unique key stays the guard for a race.
  if (await holdsMember(tx, member.organizationId, user.id)) return fail("already_member");
  if (await atMemberLimit(tx, o, member.organizationId)) return fail("member_limit");
  if (!checked)
    await runBefore(
      config.observe,
      "organization.beforeAddMember",
      config.hooks.organization.beforeAddMember,
      {
        organization: publicOrganization(input.organization),
        member: { userId: user.id, role: member.role },
        memberUser: user,
        by: input.by,
        via: input.via,
        invitation: null,
      },
    );
  await tx.create("member", member);
  await userStays(tx, user.id);
  return ok(true);
}

export async function updateMemberRole(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string; role: string },
): Promise<Result<MemberSummary>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.updateRole);
  if (!s.ok) return s;
  const g = await grantable(config, o, s.value.organization, s.value, input.role);
  if (!g.ok) return g;
  const target = await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  const targetStanding = await effectiveIn(
    config,
    config.storage,
    input.organizationId,
    target.member.role,
  );
  // A caller never touches a member above their own rank or with a right the caller lacks.
  if (!touchCheck(s.value, targetStanding)) return fail("forbidden_rank");
  // Read the user before any write, so a missing user never answers not_found after a change.
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!user) return fail("not_found");
  const now = config.clock.now();
  const hooks = config.hooks.organization;
  const organization = publicOrganization(s.value.organization);
  const current: MemberSummary = {
    id: target.member.id,
    userId: user.id,
    role: target.member.role,
    email: user.email,
    name: user.name,
    createdAt: target.member.createdAt,
  };
  // The before hook runs inside the write's transaction, after the owner lock when there is one.
  // The role from the read is in the where: if another request changed it since, zero rows match.
  const setRole = async (storage: StorageAdapter) => {
    await runBefore(
      config.observe,
      "organization.beforeUpdateMemberRole",
      hooks.beforeUpdateMemberRole,
      {
        organization,
        member: current,
        role: input.role,
        memberUser: user,
        by: input.user,
      },
    );
    return storage.update(
      "member",
      [
        { field: "id", op: "eq", value: target.member.id },
        { field: "role", op: "eq", value: target.member.role },
      ],
      { role: input.role, updatedAt: now },
    );
  };
  // A change that drops the platform role ends the member's impersonations (ruling 42 I1).
  const loss = await roleLossOf(
    config,
    s.value.organization,
    target.member,
    s.value.reads + g.value.reads + targetStanding.reads,
  );
  // A change that adds the platform role part holds the member's user row
  // first, in the order of user-hold.ts (ruling 6 of plan 12f2). The
  // operator delete holds the same row before it reads the platform role,
  // so the two run one at a time on Postgres and MySQL.
  const gain =
    writesPlatformRole(config, s.value.organization, input.role) &&
    !writesPlatformRole(config, s.value.organization, target.member.role)
      ? input.userId
      : null;
  const written = await hookGuard(async (): Promise<Result<true>> => {
    // The demotion can remove an owner: count, lock, and write in one transaction.
    if (isOwner(o, target.rank) && !isOwner(o, g.value.rank))
      return ownerWrite(config, o, s.value.organization, setRole, loss, gain);
    // A zero-row update writes nothing, so the commit changes nothing.
    const n = await config.storage.transaction((tx) =>
      withRoleLoss(
        tx,
        loss,
        now,
        async (t) => {
          if (gain !== null) await holdUser(config.observe, t, gain);
          return setRole(t);
        },
        (rows) => rows > 0,
      ),
    );
    return n === 0 ? fail("conflict") : ok(true);
  });
  if (!written.ok) return written;
  await sessionsEnded(config, loss?.ended, "impersonation_end", loss?.stops ?? null, loss?.count);
  const updated: MemberSummary = { ...current, role: input.role };
  await runAfter(
    config.observe,
    "organization.afterUpdateMemberRole",
    hooks.afterUpdateMemberRole,
    {
      organization,
      member: updated,
      previousRole: target.member.role,
      memberUser: user,
      by: input.user,
    },
    target.member.id,
  );
  config.observe.emit(organizationChange("afterUpdateMemberRole", organization.id));
  return ok(updated);
}

/**
 * The writes of a member removal in the caller's transaction (ruling 25 N3
 * of plan 12d). `removeMember` calls it after its before hook, and a SCIM
 * deactivate calls it with no user caller. The caller holds the person's
 * user row and sessions first, and with `revokeTokens` the organization
 * lock, in the order of user-hold.ts. The role from the caller's read is in
 * the where: when another request changed it since, zero rows match and
 * nothing else is written. The person's team rows and active team go with
 * the membership, with no team hook (plan 12k). The active organization is
 * a choice, not a right, so it goes in the same write. With `revokeTokens`
 * the organization tokens that the person created go too. The answer is the
 * count of member rows deleted.
 */
export async function removeMemberIn(
  tx: StorageAdapter,
  member: MemberRow,
  revokeTokens: boolean,
): Promise<number> {
  const n = await tx.delete("member", [
    { field: "id", op: "eq", value: member.id },
    { field: "role", op: "eq", value: member.role },
  ]);
  if (n === 0) return 0;
  await dropMemberTeams(tx, member.organizationId, member.userId);
  await tx.update(
    "session",
    [
      { field: "userId", op: "eq", value: member.userId },
      { field: "activeOrganizationId", op: "eq", value: member.organizationId },
    ],
    { activeOrganizationId: null },
  );
  if (revokeTokens)
    await tx.delete("organizationToken", [
      { field: "organizationId", op: "eq", value: member.organizationId },
      { field: "createdById", op: "eq", value: member.userId },
    ]);
  return n;
}

/** The second right of `revokeTokens` (deviation 9 of plan 12k): a creator has no right of their own on a token. */
const REVOKE_TOKENS: Statements = { apiToken: ["revoke"] };

/**
 * Removes a member, or the caller (a leave). The organization tokens of the
 * person stay (owner decision 2 of plan 12k). With `revokeTokens: true` the
 * rows of this organization with the person as `createdById` go in the same
 * transaction as the member row. That transaction first takes the
 * organization lock of the token create. That needs `apiToken:revoke` as well, also for a leave, checked
 * before any write. The route also checks the fresh
 * rule then; an in-process call is the app's own act (ruling 8 of plan 12k).
 *
 * The transaction holds the person's user row first (ruling 43). A team
 * member add and an accept hold the same row, and then read the member row
 * through their transaction. So the removal waits for their commit and then
 * deletes their team rows, or they see the member row gone. The locks of
 * the person's sessions come next, before the organization lock and the
 * deletes (ruling 49). The removal clears their active organization and
 * team last. A team write locks them before its team row.
 */
export async function removeMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string; revokeTokens?: boolean },
): Promise<Result<{ ok: true }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input);
  if (!v.ok) return v;
  const self = input.userId === input.user.id;
  const revokeTokens = input.revokeTokens === true;
  // Leave needs membership only, at any rank. Remove of another member needs the removeOther rule.
  const rule = self ? null : RULE_STATEMENTS.removeOther;
  const wanted = revokeTokens ? union(rule ?? {}, REVOKE_TOKENS) : rule;
  const s = await standing(config, input.user, input.organizationId, wanted);
  if (!s.ok) return s;
  const target = self ? s.value : await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  // A leave reads no second role: the caller is the target.
  const targetStanding = self
    ? null
    : await effectiveIn(config, config.storage, input.organizationId, target.member.role);
  if (targetStanding !== null && !touchCheck(s.value, targetStanding))
    return fail("forbidden_rank");
  // The member's user, for the hook event. Read before any write.
  const memberUser = self
    ? input.user
    : await config.storage.findOne("user", [{ field: "id", op: "eq", value: input.userId }]);
  if (!memberUser) return fail("not_found");
  const hooks = config.hooks.organization;
  const via: RemoveVia = self ? "leave" : "remove";
  const event = {
    organization: publicOrganization(s.value.organization),
    member: {
      id: target.member.id,
      userId: target.member.userId,
      role: target.member.role,
      email: memberUser.email,
      name: memberUser.name,
      createdAt: target.member.createdAt,
    },
    memberUser,
    by: input.user,
    via,
  };
  // The writes of the removal are removeMemberIn, after the before hook.
  const drop = async (storage: StorageAdapter) => {
    // The lock of the token create (ruling 32 of plan 12k). A create that holds it commits
    // first, and the token delete below sees its row. The user hold and the session locks run
    // before this lock, in the order of user-hold.ts. A gone organization answers conflict.
    if (revokeTokens && !(await lockOrganization(storage, s.value.organization))) return 0;
    await runBefore(
      config.observe,
      "organization.beforeRemoveMember",
      hooks.beforeRemoveMember,
      event,
    );
    return removeMemberIn(storage, target.member, revokeTokens);
  };
  // A removal or a leave of the platform organization ends the member's
  // impersonations (ruling 42 I1).
  const loss = await roleLossOf(
    config,
    s.value.organization,
    target.member,
    s.value.reads + (targetStanding?.reads ?? 0),
  );
  const now = config.clock.now();
  const removed = await hookGuard(async (): Promise<Result<true>> => {
    // The removal of an owner: count, lock, and write in one transaction.
    if (isOwner(o, target.rank))
      return ownerWrite(config, o, s.value.organization, drop, loss, target.member.userId);
    // A delete of zero rows writes nothing, and the hold writes no new value, so the commit changes nothing.
    // With a loss, withRoleLoss holds the member's user row and sessions first (ruling 43 of plan 12k).
    const n = await config.storage.transaction((tx) =>
      withRoleLoss(
        tx,
        loss,
        now,
        async (t) => {
          if (!loss) {
            await holdUser(config.observe, t, target.member.userId);
            // The sessions before the organization lock and the deletes (ruling 49 of plan 12k).
            await holdSessions(t, target.member.userId);
          }
          return drop(t);
        },
        (rows) => rows > 0,
      ),
    );
    return n === 0 ? fail("conflict") : ok(true);
  });
  if (!removed.ok) return removed;
  await sessionsEnded(config, loss?.ended, "impersonation_end", loss?.stops ?? null, loss?.count);
  await runAfter(
    config.observe,
    "organization.afterRemoveMember",
    hooks.afterRemoveMember,
    event,
    target.member.id,
  );
  config.observe.emit(organizationChange("afterRemoveMember", event.organization.id));
  return ok({ ok: true });
}
