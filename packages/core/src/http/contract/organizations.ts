import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SessionAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** A core id has 26 characters (newId). The cap of 64 leaves a margin and bounds the read. */
export const id = z.string().min(1).max(64);
const role = z.string().min(1).max(64);
/** Every member reads metadata in GET /organizations, so its size is capped. */
const METADATA_MAX_BYTES = 4096;
const metadata = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional()
  .refine(
    (m) =>
      m === undefined ||
      m === null ||
      new TextEncoder().encode(JSON.stringify(m)).length <= METADATA_MAX_BYTES,
  );

export const createBody = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  metadata,
});
export const updateBody = z.object({
  organizationId: id,
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(64).optional(),
  metadata,
});
export const orgBody = z.object({ organizationId: id });
export const memberBody = z.object({ organizationId: id, userId: id, role });
/** `revokeTokens` (plan 12k): the person's organization tokens go with the member row. */
export const removeBody = z.object({
  organizationId: id,
  userId: id,
  revokeTokens: z.boolean().optional(),
});
export const inviteBody = z.object({
  organizationId: id,
  email: z.string().min(1).max(320),
  role,
  // Plan 12k: the teams that the accept adds the person to. The engine checks each one.
  teamIds: z.array(id).max(20).optional(),
});
export const revokeBody = z.object({ organizationId: id, invitationId: id });
export const tokenBody = z.object({ token: z.string().min(1).max(64) });
export const activeBody = z.object({ organizationId: id.nullable() });
/** A resource or an action name, as `NAME_RE` of the access entry bounds it. `can` decides the rest. */
const statementName = z.string().min(1).max(32);
/** A statement set in a request: at most 64 resources of at most 64 actions, so the read stays small. */
const statements = z
  .record(statementName, z.array(statementName).max(64))
  .refine((set) => Object.keys(set).length <= 64);
/** Strict: a key such as Better Auth's `permission` answers invalid_body, not a silent false. */
export const hasPermissionBody = z.strictObject({ organizationId: id, permissions: statements });
/** A slug to check: the same bound as the create, before the fold. normalizeSlug decides the rest. */
export const checkSlugBody = z.strictObject({ slug: z.string().min(1).max(64) });
/**
 * An organization token create (plan 12k). Strict, so a window or a quota from
 * a client answers `invalid_body`: only the app sets them, in process. The
 * set is required; `{}` grants nothing. The engine refuses a name over 80
 * code units; this cap only bounds the body.
 */
export const orgTokenCreateBody = z.strictObject({
  organizationId: id,
  name: z.string().max(200),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  permissions: statements,
  metadata,
});
/** The narrow-only update of an organization token. Strict, as the create. */
export const orgTokenUpdateBody = z.strictObject({
  organizationId: id,
  id,
  name: z.string().max(200).optional(),
  permissions: statements.optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});
export const orgTokenRevokeBody = z.object({ organizationId: id, id });

/** The query of the two lists: the route reads `organizationId` by hand and parses it with `id`. */
export const orgQuery = z.object({ organizationId: id });

/** One organization, as `publicOrganization` answers it. */
export const OrganizationJson = z.strictObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});

/** One member of an organization, with the user's address and name. */
export const MemberJson = z.strictObject({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  /** Null for a member with no address (plan 12i). */
  email: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** One pending invitation. The token is in the mail only, never in an answer. */
export const InvitationJson = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string(),
  inviterId: z.string(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

/** The create and the accept answer the organization with the caller's membership. */
const organizationAndMember = z.strictObject({
  organization: OrganizationJson,
  member: MemberJson,
});
const memberAnswer = z.strictObject({ member: MemberJson });
const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** A statement set in an answer. */
const StatementsJson = z.record(z.string(), z.array(z.string()));

/** One organization token, as `publicOrganizationToken` answers it. Never the hash, never the token. */
export const OrganizationTokenJson = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  hint: z.string(),
  permissions: StatementsJson,
  metadata: z.record(z.string(), z.unknown()).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  rateLimit: z.strictObject({ seconds: z.number().int(), max: z.number().int() }).nullable(),
  remaining: z.number().int().nullable(),
  retired: z.boolean(),
  createdById: z.string(),
  creatorIsMember: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** The contract of `routes/organizations.ts` (plan 11g). */
export const ORGANIZATIONS_CONTRACT = {
  "POST /organizations/create": {
    body: jsonBody(createBody),
    answer: { kind: "json", schema: organizationAndMember },
  },
  "GET /organizations": {
    answer: {
      kind: "json",
      schema: z.strictObject({
        organizations: z.array(
          z.strictObject({ organization: OrganizationJson, role: z.string() }),
        ),
      }),
    },
  },
  "POST /organizations/update": {
    body: jsonBody(updateBody),
    answer: { kind: "json", schema: z.strictObject({ organization: OrganizationJson }) },
  },
  "POST /organizations/delete": {
    body: jsonBody(orgBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "GET /organizations/members": {
    query: { schema: orgQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: z.strictObject({ members: z.array(MemberJson) }) },
  },
  "POST /organizations/members/add": {
    body: jsonBody(memberBody),
    answer: { kind: "json", schema: memberAnswer },
  },
  "POST /organizations/members/role": {
    body: jsonBody(memberBody),
    answer: { kind: "json", schema: memberAnswer },
  },
  "POST /organizations/members/remove": {
    body: jsonBody(removeBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /organizations/invite": {
    body: jsonBody(inviteBody),
    answer: { kind: "json", schema: z.strictObject({ invitation: InvitationJson }) },
  },
  "GET /organizations/invitations": {
    query: { schema: orgQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: z.strictObject({ invitations: z.array(InvitationJson) }) },
  },
  "POST /organizations/invitations/revoke": {
    body: jsonBody(revokeBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /organizations/invitations/accept": {
    body: jsonBody(tokenBody),
    answer: { kind: "json", schema: organizationAndMember },
  },
  "POST /organizations/invitations/decline": {
    body: jsonBody(tokenBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /organizations/has-permission": {
    body: jsonBody(hasPermissionBody),
    answer: { kind: "json", schema: z.strictObject({ success: z.boolean() }) },
  },
  "GET /organizations/permissions": {
    query: { schema: orgQuery, parsedBy: "hand" },
    // A non-member gets a null role and the empty set.
    answer: {
      kind: "json",
      schema: z.strictObject({ role: z.string().nullable(), permissions: StatementsJson }),
    },
  },
  "POST /organizations/check-slug": {
    body: jsonBody(checkSlugBody),
    // A null slug for `invalid`: the input does not fold to a slug.
    answer: {
      kind: "json",
      schema: z.strictObject({
        slug: z.string().nullable(),
        status: z.enum(["available", "taken", "reserved", "invalid"]),
      }),
    },
  },
  "POST /organizations/tokens": {
    body: jsonBody(orgTokenCreateBody),
    // The token is answered once. Every later answer holds the hint only.
    answer: {
      kind: "json",
      schema: z.strictObject({ token: z.string(), apiToken: OrganizationTokenJson }),
    },
  },
  "GET /organizations/tokens": {
    query: { schema: orgQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: z.strictObject({ tokens: z.array(OrganizationTokenJson) }) },
  },
  "POST /organizations/tokens/update": {
    body: jsonBody(orgTokenUpdateBody),
    answer: { kind: "json", schema: OrganizationTokenJson },
  },
  "POST /organizations/tokens/revoke": {
    body: jsonBody(orgTokenRevokeBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "GET /organizations/tokens/current": {
    // The organization, and no user: the token acts for the organization.
    answer: {
      kind: "json",
      schema: z.strictObject({ organization: OrganizationJson, apiToken: OrganizationTokenJson }),
    },
  },
  "POST /organizations/active": {
    body: jsonBody(activeBody),
    // The session with its new active organization, as `publicSession` answers it.
    answer: { kind: "json", schema: SessionAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
