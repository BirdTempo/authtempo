import type { ResolvedConfig } from "../config.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { InvitationRow, MemberRow, OrganizationRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
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
  await config.storage.transaction(async (tx) => {
    // One pending invitation per address: a new invite replaces the old one, so the old link dies.
    await tx.delete("invitation", [
      { field: "organizationId", op: "eq", value: input.organizationId },
      { field: "email", op: "eq", value: email },
      { field: "acceptedAt", op: "eq", value: null },
    ]);
    await tx.create("invitation", row);
  });
  const link = o.invitationLinkBuilder(token, {
    slug: s.value.organization.slug,
    name: s.value.organization.name,
  });
  await config.mail.send({
    to: email,
    subject: `You are invited to ${s.value.organization.name}`,
    text: `${input.user.email} invited you to ${s.value.organization.name} on ${new URL(config.appURL).host}. Open this link to accept. It is valid for ${o.invitationTtlDays} days.\n\n${link}\n\nIf you do not know this organization, ignore this message.`,
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
  const n = await config.storage.delete("invitation", [
    { field: "id", op: "eq", value: input.invitationId },
    { field: "organizationId", op: "eq", value: input.organizationId },
  ]);
  return n === 0 ? fail("not_found") : ok({ ok: true });
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

export async function acceptInvitation(
  config: ResolvedConfig,
  input: Caller & { token: string; ip: string | null },
): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>> {
  const o = config.organizations;
  if (!o) return fail("not_found");
  if (!(await config.limiter.allow(`invitation-accept:ip:${input.ip ?? "unknown"}`, ACCEPT_LIMIT)))
    return fail("rate_limited");
  const live = await liveInvitation(config, input.token);
  if (!live.ok) return live;
  const inv = live.value;
  // The same rule as a social claim: only the verified holder of the invited address may accept.
  if (!input.user.emailVerified) return fail("email_unverified");
  if (input.user.email !== inv.email) return fail("email_mismatch");
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: inv.organizationId },
  ]);
  if (!organization) return fail("invalid_token");
  const now = config.clock.now();
  let member: MemberRow | null = null;
  try {
    member = await config.storage.transaction(async (tx) => {
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
      const existing = await tx.findOne("member", [
        { field: "organizationId", op: "eq", value: inv.organizationId },
        { field: "userId", op: "eq", value: input.user.id },
      ]);
      if (existing) {
        if (rankOf(o.ranks, inv.role) > rankOf(o.ranks, existing.role)) {
          await tx.update("member", [{ field: "id", op: "eq", value: existing.id }], {
            role: inv.role,
            updatedAt: now,
          });
          return { ...existing, role: inv.role, updatedAt: now };
        }
        return existing;
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
      return row;
    });
  } catch (err) {
    // A concurrent addMember won the unique key; the transaction rolled back, so the token is still live. The person retries.
    if (err instanceof StorageError && err.code === "unique_violation")
      return fail("already_member");
    throw err;
  }
  if (!member) return fail("invalid_token");
  return ok({
    organization: publicOrganization(organization),
    member: {
      id: member.id,
      userId: member.userId,
      role: member.role,
      email: input.user.email,
      name: input.user.name,
      createdAt: member.createdAt,
    },
  });
}

export async function declineInvitation(
  config: ResolvedConfig,
  input: { token: string },
): Promise<Result<{ ok: true }>> {
  if (!config.organizations) return fail("not_found");
  const live = await liveInvitation(config, input.token);
  if (!live.ok) return live;
  const n = await config.storage.delete("invitation", [
    { field: "id", op: "eq", value: live.value.id },
    { field: "acceptedAt", op: "eq", value: null },
  ]);
  return n === 0 ? fail("invalid_token") : ok({ ok: true });
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
