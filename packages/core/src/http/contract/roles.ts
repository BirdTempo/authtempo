import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { id } from "./organizations.js";
import { OkAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** One part of a role string. The engine checks `ROLE_RE`; this cap only bounds the body. */
const name = z.string().min(1).max(64);
/** A resource or an action name, as `NAME_RE` of the access entry bounds it. `statementFault` decides the rest. */
const statementName = z.string().min(1).max(32);
/** A statement set in a request: at most 64 resources of at most 64 actions, so the read stays small. */
const statements = z
  .record(statementName, z.array(statementName).max(64))
  .refine((set) => Object.keys(set).length <= 64);
/** The engine checks the range: 1 to the caller's rank, below the owner rank. */
const rank = z.number().int();

// Strict: a key of Better Auth's role routes, such as `role` or `permission`, answers invalid_body.
export const roleCreateBody = z.strictObject({
  organizationId: id,
  name,
  rank: rank.optional(),
  permissions: statements,
});
export const roleUpdateBody = z.strictObject({
  organizationId: id,
  name,
  rank: rank.optional(),
  permissions: statements.optional(),
});
export const roleNameBody = z.strictObject({ organizationId: id, name });

/** The query of the list: the route reads `organizationId` by hand and parses it with `id`. */
export const roleListQuery = z.object({ organizationId: id });
/** The query of the get: the route reads both keys by hand. */
export const roleGetQuery = z.object({ organizationId: id, name });

/** One stored role, as `RoleSummary` answers it. */
export const RoleJson = z.strictObject({
  id: z.string(),
  name: z.string(),
  rank: z.number().int(),
  permissions: z.record(z.string(), z.array(z.string())),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const roleAnswer = z.strictObject({ role: RoleJson });
const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** The contract of `routes/roles.ts` (plan 12k Task 4). */
export const ROLES_CONTRACT = {
  "GET /organizations/roles": {
    query: { schema: roleListQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: z.strictObject({ roles: z.array(RoleJson) }) },
  },
  "GET /organizations/roles/get": {
    query: { schema: roleGetQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: roleAnswer },
  },
  "POST /organizations/roles/create": {
    body: jsonBody(roleCreateBody),
    answer: { kind: "json", schema: roleAnswer },
  },
  "POST /organizations/roles/update": {
    body: jsonBody(roleUpdateBody),
    answer: { kind: "json", schema: roleAnswer },
  },
  "POST /organizations/roles/delete": {
    body: jsonBody(roleNameBody),
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
