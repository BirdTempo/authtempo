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
export const removeBody = z.object({ organizationId: id, userId: id });
export const inviteBody = z.object({
  organizationId: id,
  email: z.string().min(1).max(320),
  role,
});
export const revokeBody = z.object({ organizationId: id, invitationId: id });
export const tokenBody = z.object({ token: z.string().min(1).max(64) });
export const activeBody = z.object({ organizationId: id.nullable() });

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
  email: z.string(),
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
  "POST /organizations/active": {
    body: jsonBody(activeBody),
    // The session with its new active organization, as `publicSession` answers it.
    answer: { kind: "json", schema: SessionAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
