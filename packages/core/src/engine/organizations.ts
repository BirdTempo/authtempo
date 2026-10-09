import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { MemberRow, OrganizationRow, UserRow } from "../schema.js";
import { findManyIn } from "../storage/batch.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
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

/** The name goes into a mail subject; a CR or LF would inject a header. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class names the control characters it refuses.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function validName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX && !CONTROL_RE.test(name);
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
  rule: keyof typeof RULES,
): Promise<Result<{ member: MemberRow; organization: OrganizationRow; rank: number }>> {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return fail("not_found");
  const m = await membership(config, organizationId, user.id);
  if (!m) return fail("forbidden_rank");
  if (m.rank < needs(o, rule)) return fail("forbidden_rank");
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
 * A write that can remove an owner: the owner count, the lock, and the write
 * run in one transaction. `organization` is the row from the standing read.
 *
 * The port has no row lock. The conditional update of updatedAt is an
 * optimistic lock: of two concurrent owner writes, the second matches zero
 * rows (Postgres re-checks the WHERE after the first commit; D1 and memory
 * run statements in order) and answers conflict.
 *
 * Each refusal returns a value from the transaction function and never
 * throws: no write has run at that point, so the commit changes nothing.
 */
async function ownerWrite(
  config: ResolvedConfig,
  o: ResolvedOrganizations,
  organization: OrganizationRow,
  write: (tx: StorageAdapter) => Promise<void>,
): Promise<Result<true>> {
  const now = config.clock.now();
  const seen = organization.updatedAt;
  return config.storage.transaction(async (tx): Promise<Result<true>> => {
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
    await write(tx);
    return ok(true);
  });
}

export async function createOrganization(
  config: ResolvedConfig,
  input: Caller & { slug: string; name: string; metadata?: Record<string, unknown> | null },
): Promise<Result<{ organization: OrganizationSummary; member: MemberRow }>> {
  const o = on(config);
  if (!o) return fail("not_found");
  const v = verified(input.user);
  if (!v.ok) return v;
  const slug = normalizeSlug(input.slug);
  if (slug === null || !validName(input.name)) return fail("invalid_body");
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
  try {
    await config.storage.transaction(async (tx) => {
      await tx.create("organization", organization);
      await tx.create("member", member);
    });
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation") return fail("slug_taken");
    throw err;
  }
  return ok({ organization: publicOrganization(organization), member });
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
  const data: Partial<OrganizationRow> = {};
  if (input.name !== undefined) {
    if (!validName(input.name)) return fail("invalid_body");
    data.name = input.name;
  }
  if (input.metadata !== undefined) data.metadata = input.metadata;
  if (input.slug !== undefined) {
    if (s.value.rank < needs(o, "slugChange")) return fail("forbidden_rank");
    const slug = normalizeSlug(input.slug);
    if (slug === null) return fail("invalid_body");
    if (o.reservedSlugs.has(slug)) return fail("slug_reserved");
    data.slug = slug;
  }
  if (Object.keys(data).length === 0) return ok(publicOrganization(s.value.organization));
  const now = config.clock.now();
  try {
    await config.storage.update(
      "organization",
      [{ field: "id", op: "eq", value: input.organizationId }],
      { ...data, updatedAt: now },
    );
  } catch (err) {
    if (err instanceof StorageError && err.code === "unique_violation") return fail("slug_taken");
    throw err;
  }
  return ok(publicOrganization({ ...s.value.organization, ...data, updatedAt: now }));
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
  const id = input.organizationId;
  await config.storage.transaction(async (tx) => {
    await tx.delete("member", [{ field: "organizationId", op: "eq", value: id }]);
    await tx.delete("invitation", [{ field: "organizationId", op: "eq", value: id }]);
    // A session that points at a deleted organization would make every later rank check read a missing row.
    await tx.update("session", [{ field: "activeOrganizationId", op: "eq", value: id }], {
      activeOrganizationId: null,
    });
    await tx.delete("organization", [{ field: "id", op: "eq", value: id }]);
  });
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
  try {
    await config.storage.create("member", member);
  } catch (err) {
    if (err instanceof StorageError && err.code === "unique_violation")
      return fail("already_member");
    throw err;
  }
  return ok({
    id: member.id,
    userId: target.id,
    role: member.role,
    email: target.email,
    name: target.name,
    createdAt: now,
  });
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
  const now = config.clock.now();
  const setRole = async (storage: StorageAdapter) => {
    await storage.update("member", [{ field: "id", op: "eq", value: target.member.id }], {
      role: input.role,
      updatedAt: now,
    });
  };
  if (isOwner(o, target.rank) && !isOwner(o, g.value)) {
    // The demotion can remove an owner: count, lock, and write in one transaction.
    const w = await ownerWrite(config, o, s.value.organization, setRole);
    if (!w.ok) return w;
  } else {
    await setRole(config.storage);
  }
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!user) return fail("not_found");
  return ok({
    id: target.member.id,
    userId: user.id,
    role: input.role,
    email: user.email,
    name: user.name,
    createdAt: target.member.createdAt,
  });
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
  const s = await standing(
    config,
    o,
    input.user,
    input.organizationId,
    self ? "members" : "removeOther",
  );
  if (!s.ok) return s;
  const target = self ? s.value : await membership(config, input.organizationId, input.userId);
  if (!target) return fail("not_found");
  if (!self && target.rank > s.value.rank) return fail("forbidden_rank");
  const drop = async (storage: StorageAdapter) => {
    await storage.delete("member", [{ field: "id", op: "eq", value: target.member.id }]);
  };
  if (isOwner(o, target.rank)) {
    // The removal of an owner: count, lock, and write in one transaction.
    const w = await ownerWrite(config, o, s.value.organization, drop);
    if (!w.ok) return w;
  } else {
    await drop(config.storage);
  }
  return ok({ ok: true });
}
