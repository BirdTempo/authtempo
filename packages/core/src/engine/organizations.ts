import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { MemberRow, OrganizationRow, UserRow } from "../schema.js";
import { findManyIn } from "../storage/batch.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { hookGuard, type OrganizationPatch, type RemoveVia, runAfter, runBefore } from "./hooks.js";
import {
  needs,
  normalizeSlug,
  type ResolvedOrganizations,
  ROLE_RE,
  type RULES,
  rankOf,
  roleAllowedIn,
} from "./ranks.js";

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
 * The caller's standing for a rule. A missing id answers not_found and a
 * non-member forbidden_rank. Ids are ULIDs and slugs are public, so existence
 * is not a secret; the distinct codes let a client tell a dead link from a
 * missing right.
 */
async function standing(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  user: UserRow,
  organizationId: string,
  rule: keyof typeof RULES | null,
): Promise<Result<{ member: MemberRow; organization: OrganizationRow; rank: number }>> {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return fail("not_found");
  const m = await membership(config, organizationId, user.id);
  if (!m) return fail("forbidden_rank");
  // A null rule needs membership only: a member may leave at any rank, rank 0 included.
  if (rule !== null && m.rank < needs(o, rule)) return fail("forbidden_rank");
  return ok(m);
}

function verified(user: UserRow): Result<true> {
  return user.emailVerified ? ok(true) : fail("email_unverified");
}

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

function isOwner(o: ResolvedOrganizations, rank: number): boolean {
  return rank >= (o.ranks.owner ?? Number.POSITIVE_INFINITY);
}

/**
 * Thrown inside a transaction to roll back writes that already ran, then
 * caught outside it and answered as conflict. A thrown error is the only
 * signal that makes every adapter undo its writes.
 */
class OwnerConflict extends Error {}

/**
 * A write that can remove an owner: the owner count, the lock, the write, and
 * the recount run in one transaction. `organization` is the row from the
 * standing read. `write` returns the number of member rows it changed.
 *
 * The port has no row lock. The conditional update of updatedAt is an
 * optimistic lock: on Postgres the second of two concurrent owner writes
 * re-checks the WHERE after the first commit, matches zero rows, and answers
 * conflict. Memory runs one transaction at a time.
 *
 * D1 transactions are not isolated: a second request can read the stamp this
 * transaction wrote and pass the lock before this transaction deletes its
 * owner. The recount after the write catches that case. If no owner remains,
 * the sentinel rolls this transaction back, and the later of the two racers
 * answers conflict.
 *
 * A refusal before the first write returns a value and does not throw: no
 * write has run at that point, so the commit changes nothing.
 */
async function ownerWrite(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  write: (tx: StorageAdapter) => Promise<number>,
): Promise<Result<true>> {
  const now = config.clock.now();
  const seen = organization.updatedAt;
  try {
    return await config.storage.transaction(async (tx): Promise<Result<true>> => {
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
      if ((await write(tx)) === 0) throw new OwnerConflict();
      if ((await ownerCount(tx, o, organization.id)) < 1) throw new OwnerConflict();
      return ok(true);
    });
  } catch (err) {
    if (err instanceof OwnerConflict) return fail("conflict");
    throw err;
  }
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
        await tx.create("organization", organization);
        await tx.create("member", member);
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
  const s = await standing(config, o, input.user, input.organizationId, "update");
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
  const s = await standing(config, o, input.user, input.organizationId, "delete");
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
      await tx.delete("member", [{ field: "organizationId", op: "eq", value: id }]);
      await tx.delete("invitation", [{ field: "organizationId", op: "eq", value: id }]);
      // A session that points at a deleted organization would make every later rank check read a missing row.
      await tx.update("session", [{ field: "activeOrganizationId", op: "eq", value: id }], {
        activeOrganizationId: null,
      });
      await tx.delete("organization", [{ field: "id", op: "eq", value: id }]);
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
  const s = await standing(config, o, input.user, input.organizationId, "members");
  if (!s.ok) return s;
  const members = await config.storage.findMany("member", [
    { field: "organizationId", op: "eq", value: input.organizationId },
  ]);
  return ok(await summaries(config, members));
}

/** The role is well-formed, allowed in this organization, and not above the caller's rank. */
function grantable(
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  callerRank: number,
  role: string,
): Result<number> {
  if (!ROLE_RE.test(role) || !roleAllowedIn(o, role, organization.slug))
    return fail("invalid_body");
  const rank = rankOf(o.ranks, role);
  // An unknown role ranks 0 and would be a silent no-rights member; refuse it with the same code as an escalation, so the caller learns nothing about the table.
  if (rank === 0 || rank > callerRank) return fail("forbidden_rank");
  return ok(rank);
}

export async function addMember(
  config: ResolvedConfig,
  input: Caller & { organizationId: string; userId: string; role: string },
): Promise<Result<MemberSummary>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const s = await standing(config, o, input.user, input.organizationId, "addMember");
  if (!s.ok) return s;
  const g = grantable(o, s.value.organization, s.value.rank, input.role);
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
        await tx.create("member", member);
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
  const s = await standing(config, o, input.user, input.organizationId, "updateRole");
  if (!s.ok) return s;
  const g = grantable(o, s.value.organization, s.value.rank, input.role);
  if (!g.ok) return g;
  const target = await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  // A caller never touches a member above their own rank.
  if (target.rank > s.value.rank) return fail("forbidden_rank");
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
  const written = await hookGuard(async (): Promise<Result<true>> => {
    // The demotion can remove an owner: count, lock, and write in one transaction.
    if (isOwner(o, target.rank) && !isOwner(o, g.value))
      return ownerWrite(config, o, s.value.organization, setRole);
    // A zero-row update writes nothing, so the commit changes nothing.
    const n = await config.storage.transaction((tx) => setRole(tx));
    return n === 0 ? fail("conflict") : ok(true);
  });
  if (!written.ok) return written;
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
    o,
    input.user,
    input.organizationId,
    self ? null : "removeOther",
  );
  if (!s.ok) return s;
  const target = self ? s.value : await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  if (!self && target.rank > s.value.rank) return fail("forbidden_rank");
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
  const removed = await hookGuard(async (): Promise<Result<true>> => {
    // The removal of an owner: count, lock, and write in one transaction.
    if (isOwner(o, target.rank)) return ownerWrite(config, o, s.value.organization, drop);
    // A delete of zero rows writes nothing, so the commit changes nothing.
    const n = await config.storage.transaction((tx) => drop(tx));
    return n === 0 ? fail("conflict") : ok(true);
  });
  if (!removed.ok) return removed;
  await runAfter(
    "organization.afterRemoveMember",
    hooks.afterRemoveMember,
    event,
    target.member.id,
  );
  return ok({ ok: true });
}
