import { can, type Statements } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { MemberRow, OrganizationRow, SessionRow, UserRow } from "../schema.js";
import { findManyIn } from "../storage/batch.js";
import { meterOf } from "../storage/meter.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import {
  hookGuard,
  type OrganizationPatch,
  type RemoveVia,
  runAfter,
  runBefore,
  stopWith,
} from "./hooks.js";
import { endImpersonationsPage } from "./operator/access-end.js";
import { type ImpersonationStops, impersonationStops } from "./operator/audit.js";
import { writesPlatformRole } from "./operator/guards.js";
import { holdImpersonations } from "./operator/impersonation.js";
import { OPERATOR_CALL_BUDGET, STEP_WORST } from "./operator/sessions.js";
import { effectiveIn, grantCheck, type Standing, touchCheck } from "./permissions.js";
import {
  needs,
  normalizeSlug,
  type ResolvedOrganizations,
  ROLE_RE,
  RULE_STATEMENTS,
  rankOf,
  roleAllowedIn,
} from "./ranks.js";
import { endedList, sessionsEnded } from "./sessions.js";
import { spendSlugRead } from "./slug-check.js";
import { holdUser, userStays } from "./user-hold.js";

export interface Caller {
  user: UserRow;
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
  email: string;
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
 */
export async function standing(
  config: ResolvedConfig,
  user: UserRow,
  organizationId: string,
  wanted: Statements | null,
): Promise<
  Result<{ member: MemberRow; organization: OrganizationRow; rank: number; granted: Statements }>
> {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return fail("not_found");
  const m = await membership(config, organizationId, user.id);
  if (!m) return fail("forbidden_rank");
  // The rank of a dynamic role counts too (plan 12k Task 4), so a grant compares like with like.
  const { rank, granted } = await effectiveIn(
    config,
    config.storage,
    organizationId,
    m.member.role,
  );
  // A null set needs membership only: a member may leave at any rank, rank 0 included.
  if (wanted !== null && !can(granted, wanted)) return fail("forbidden_rank");
  return ok({ ...m, rank, granted });
}

function verified(user: UserRow): Result<true> {
  return user.emailVerified ? ok(true) : fail("email_unverified");
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

/** True when `rank` is at the owner rank or above: the member counts as an owner. */
export function isOwner(o: ResolvedOrganizations, rank: number): boolean {
  return rank >= (o.ranks.owner ?? Number.POSITIVE_INFINITY);
}

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
 * write has run at that point, so the commit changes nothing.
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

/** A write that can remove an owner: `ownerLock` in its own transaction. The caller runs it in `hookGuard`. */
async function ownerWrite(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  write: (tx: StorageAdapter) => Promise<number>,
  loss: RoleLoss | null = null,
): Promise<Result<true>> {
  const now = config.clock.now();
  return config.storage.transaction((tx) =>
    withRoleLoss(
      tx,
      loss,
      now,
      (t) => ownerLock(t, o, organization, write, now),
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
  stops: ImpersonationStops | null;
  before: number;
}

/**
 * The calls of a member write before its transaction, at the worst
 * (ruling 63 of plan 12f). Through the route: the impersonation step of
 * the router, the route limiter, and `resolveSession` (3). Then the
 * standing of the caller (2), the member row of the target, and its user.
 * The ready check of the storage comes on top. The D1 test
 * `operator-loss-budget.test.ts` counts the whole invocation on the
 * binding.
 */
const MEMBER_WRITE_CALLS_BEFORE = 9;

/** The worst case of the member write in `withRoleLoss`: the owner lock, the write, and the recount. */
const MEMBER_WRITE_WORST = 5;

/** The loss of a member write, or null when the write keeps the platform role. */
async function roleLossOf(
  config: ResolvedConfig,
  organization: OrganizationRow,
  member: MemberRow,
): Promise<RoleLoss | null> {
  if (!writesPlatformRole(config, organization, member.role)) return null;
  return {
    config,
    userId: member.userId,
    ended: endedList(config),
    stops: impersonationStops(config, "role_loss"),
    before: MEMBER_WRITE_CALLS_BEFORE + ((await config.storage.readyStatements?.()) ?? 1),
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
  const meter = meterOf(tx, loss.before);
  await holdUser(tx, loss.userId);
  meter.step(STEP_WORST.hold);
  const hold = await holdImpersonations(tx, loss.config, loss.userId, now, true);
  // The audit read and the lock read.
  meter.step(2);
  const value = await work(tx);
  meter.step(MEMBER_WRITE_WORST);
  // No call after the commit reads the storage, so the page keeps none.
  if (wrote(value))
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
    );
  return value;
}

export async function createOrganization(
  config: ResolvedConfig,
  input: Caller & { slug: string; name: string; metadata?: Record<string, unknown> | null },
): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
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
        // The count and the slug read run before any write, so a refusal commits nothing.
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
        await runBefore("organization.beforeCreate", hooks.beforeCreate, {
          organization: summary,
          user: input.user,
        });
        await runBefore("organization.beforeAddMember", hooks.beforeAddMember, {
          organization: summary,
          member: { userId: input.user.id, role: member.role },
          memberUser: input.user,
          by: input.user,
          via: "create",
          invitation: null,
        });
        // After the hooks (the D1 undo), and before the writes. A member row
        // of a deleted user would count as an owner (plan 12a Task 11).
        await holdUser(tx, input.user.id);
        await tx.create("organization", organization);
        await tx.create("member", member);
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
  await runAfter(
    "organization.afterCreate",
    hooks.afterCreate,
    { organization: summary, member: owner, user: input.user },
    organization.id,
  );
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
  const v = verified(input.user);
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
        await runBefore("organization.beforeUpdate", hooks.beforeUpdate, {
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
    "organization.afterUpdate",
    hooks.afterUpdate,
    { organization: stored, member: callerMember, user: input.user },
    stored.id,
  );
  return ok(stored);
}

export async function deleteOrganization(
  config: ResolvedConfig,
  input: Caller & { organizationId: string },
): Promise<Result<{ ok: true }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.delete);
  if (!s.ok) return s;
  // The app seeds the platform organization; the engine never deletes it, because no route could create it again.
  if (s.value.organization.slug === o.platformOrganization) return fail("slug_reserved");
  const id = input.organizationId;
  const hooks = config.hooks.organization;
  const organization = publicOrganization(s.value.organization);
  const deleted = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<true>> => {
      await runBefore("organization.beforeDelete", hooks.beforeDelete, {
        organization,
        user: input.user,
      });
      await deleteOrganizationRows(tx, id);
      return ok(true);
    }),
  );
  if (!deleted.ok) return deleted;
  // The member and invitation rows go with the organization and fire no member hook, as in Better Auth.
  await runAfter(
    "organization.afterDelete",
    hooks.afterDelete,
    { organization, user: input.user },
    id,
  );
  return ok({ ok: true });
}

/**
 * The rows of one organization, in the caller's transaction. One copy for
 * the organization delete and the account delete (plan 12a).
 *
 * The order closes the gap of an accept in flight (plan 12a Task 11). The
 * invitations go first. On Postgres an accept holds its invitation row
 * until its commit. So this delete waits, and the member read below sees
 * that member. An accept that starts later finds no invitation. The row goes
 * before the members: D1 has no lock, and an accept reads the organization
 * after its member insert. With `alone`, the organization goes with that
 * user's account, so any other member answers `conflict`: the organization
 * is no longer one the user alone holds.
 */
export async function deleteOrganizationRows(
  tx: StorageAdapter,
  id: string,
  alone: string | null = null,
): Promise<void> {
  const byOrganization: Where<"member">[] = [{ field: "organizationId", op: "eq", value: id }];
  await tx.delete("invitation", [{ field: "organizationId", op: "eq", value: id }]);
  await tx.delete("organization", [{ field: "id", op: "eq", value: id }]);
  if (
    alone !== null &&
    (await tx.findMany("member", byOrganization)).some((m) => m.userId !== alone)
  )
    stopWith("conflict");
  await tx.delete("member", byOrganization);
  // A session that points at a deleted organization would make every later rank check read a missing row.
  await tx.update("session", [{ field: "activeOrganizationId", op: "eq", value: id }], {
    activeOrganizationId: null,
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
 */
export async function organizationsOfDelete(
  config: ResolvedConfig,
  storage: StorageAdapter,
  userId: string,
): Promise<Result<AccountOrganizations>> {
  const plan: AccountOrganizations = { going: [], owned: [] };
  const o = on(config);
  // With organizations off, the engine has no ranks. The member rows still go.
  if (!o) return ok(plan);
  for (const m of await storage.findMany("member", [
    { field: "userId", op: "eq", value: userId },
  ])) {
    const organization = await storage.findOne("organization", [
      { field: "id", op: "eq", value: m.organizationId },
    ]);
    if (!organization) continue;
    const members = await storage.findMany("member", [
      { field: "organizationId", op: "eq", value: organization.id },
    ]);
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
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : a.id < b.id ? -1 : 1));
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
): Promise<Result<Standing>> {
  if (!ROLE_RE.test(role) || !roleAllowedIn(o, role, organization.slug))
    return fail("invalid_body");
  const target = await effectiveIn(config, config.storage, organization.id, role);
  // An unknown role ranks 0 and would be a silent no-rights member; refuse it with the same code as an escalation, so the caller learns nothing about the table.
  if (target.rank === 0 || !grantCheck(caller, target)) return fail("forbidden_rank");
  return ok(target);
}

export async function addMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string; role: string },
): Promise<Result<MemberSummary>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
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
  const hooks = config.hooks.organization;
  const organization = publicOrganization(s.value.organization);
  const limit = o.limits.membersPerOrganization;
  try {
    const written = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<true>> => {
        // A no-op add runs no hook. The unique key stays the guard for a race.
        if (
          await tx.findOne("member", [
            { field: "organizationId", op: "eq", value: input.organizationId },
            { field: "userId", op: "eq", value: target.id },
          ])
        )
          return fail("already_member");
        if (limit !== null) {
          const held = await tx.findMany(
            "member",
            [{ field: "organizationId", op: "eq", value: input.organizationId }],
            { limit },
          );
          if (held.length >= limit) return fail("member_limit");
        }
        await runBefore("organization.beforeAddMember", hooks.beforeAddMember, {
          organization,
          member: { userId: target.id, role: input.role },
          memberUser: target,
          by: input.user,
          via: "add",
          invitation: null,
        });
        // The added user, for the reason of the create (plan 12a Task 11).
        await holdUser(tx, target.id);
        await tx.create("member", member);
        await userStays(tx, target.id);
        return ok(true);
      }),
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
    "organization.afterAddMember",
    hooks.afterAddMember,
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
  return ok(added);
}

export async function updateMemberRole(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string; role: string },
): Promise<Result<MemberSummary>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const s = await standing(config, input.user, input.organizationId, RULE_STATEMENTS.updateRole);
  if (!s.ok) return s;
  const g = await grantable(config, o, s.value.organization, s.value, input.role);
  if (!g.ok) return g;
  const target = await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  // A caller never touches a member above their own rank or with a right the caller lacks.
  if (
    !touchCheck(
      s.value,
      await effectiveIn(config, config.storage, input.organizationId, target.member.role),
    )
  )
    return fail("forbidden_rank");
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
    await runBefore("organization.beforeUpdateMemberRole", hooks.beforeUpdateMemberRole, {
      organization,
      member: current,
      role: input.role,
      memberUser: user,
      by: input.user,
    });
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
  const loss = await roleLossOf(config, s.value.organization, target.member);
  const written = await hookGuard(async (): Promise<Result<true>> => {
    // The demotion can remove an owner: count, lock, and write in one transaction.
    if (isOwner(o, target.rank) && !isOwner(o, g.value.rank))
      return ownerWrite(config, o, s.value.organization, setRole, loss);
    // A zero-row update writes nothing, so the commit changes nothing.
    const n = await config.storage.transaction((tx) =>
      withRoleLoss(tx, loss, now, setRole, (rows) => rows > 0),
    );
    return n === 0 ? fail("conflict") : ok(true);
  });
  if (!written.ok) return written;
  await sessionsEnded(config, loss?.ended, "impersonation_end", loss?.stops ?? null);
  const updated: MemberSummary = { ...current, role: input.role };
  await runAfter(
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
  return ok(updated);
}

export async function removeMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string },
): Promise<Result<{ ok: true }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const self = input.userId === input.user.id;
  // Leave needs membership only, at any rank. Remove of another member needs the removeOther rule.
  const s = await standing(
    config,
    input.user,
    input.organizationId,
    self ? null : RULE_STATEMENTS.removeOther,
  );
  if (!s.ok) return s;
  const target = self ? s.value : await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  if (
    !self &&
    !touchCheck(
      s.value,
      await effectiveIn(config, config.storage, input.organizationId, target.member.role),
    )
  )
    return fail("forbidden_rank");
  // The member's user, for the hook event. Read before any write.
  const memberUser = self
    ? input.user
    : await config.storage.findOne("user", [{ field: "id", op: "eq", value: input.userId }]);
  if (!memberUser) return fail("not_found");
  const organizationId = input.organizationId;
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
  // The role from the read is in the where: if another request changed it since, zero rows match.
  // The active organization is a choice, not a right; it goes with the membership in the same write.
  const drop = async (storage: StorageAdapter) => {
    await runBefore("organization.beforeRemoveMember", hooks.beforeRemoveMember, event);
    const n = await storage.delete("member", [
      { field: "id", op: "eq", value: target.member.id },
      { field: "role", op: "eq", value: target.member.role },
    ]);
    if (n === 0) return 0;
    await storage.update(
      "session",
      [
        { field: "userId", op: "eq", value: target.member.userId },
        { field: "activeOrganizationId", op: "eq", value: organizationId },
      ],
      { activeOrganizationId: null },
    );
    return n;
  };
  // A removal or a leave of the platform organization ends the member's
  // impersonations (ruling 42 I1).
  const loss = await roleLossOf(config, s.value.organization, target.member);
  const now = config.clock.now();
  const removed = await hookGuard(async (): Promise<Result<true>> => {
    // The removal of an owner: count, lock, and write in one transaction.
    if (isOwner(o, target.rank)) return ownerWrite(config, o, s.value.organization, drop, loss);
    // A delete of zero rows writes nothing, so the commit changes nothing.
    const n = await config.storage.transaction((tx) =>
      withRoleLoss(tx, loss, now, drop, (rows) => rows > 0),
    );
    return n === 0 ? fail("conflict") : ok(true);
  });
  if (!removed.ok) return removed;
  await sessionsEnded(config, loss?.ended, "impersonation_end", loss?.stops ?? null);
  await runAfter(
    "organization.afterRemoveMember",
    hooks.afterRemoveMember,
    event,
    target.member.id,
  );
  return ok({ ok: true });
}
