import { z } from "zod";
import { NS_AUTHTEMPO_SCIM_LIMITS } from "../../engine/scim/discovery.js";
import {
  type AttrRule,
  ENTERPRISE_RULES,
  NS_SCIM_ENTERPRISE,
  USER_RULES,
} from "../../engine/scim/patch.js";
import { id } from "./organizations.js";
import { OkAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

const scope = z.enum([
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
]);

// Strict: a key that core does not read answers invalid_body.
export const scimTokenListQuery = z.strictObject({ organizationId: id });
/** The schema holds the types and loose bounds; the engine holds each rule and names the field. */
export const scimTokenCreateBody = z.strictObject({
  organizationId: id,
  name: z.string().max(256),
  scopes: z.array(scope).max(8).optional(),
  expiresInDays: z.number().optional(),
});
export const scimTokenIdBody = z.strictObject({ id });

/** One token, as `ScimTokenSummary` answers it. It never holds the token or its hash. */
export const ScimTokenJson = z.strictObject({
  id: z.string(),
  name: z.string(),
  hint: z.string(),
  scopes: z.array(scope),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

/** The answer of a create: the clear token, the one time it leaves core. */
const scimTokenCreated = z.strictObject({ token: z.string(), id: z.string(), hint: z.string() });

const meta = z.strictObject({ resourceType: z.string(), location: z.string() });

/** The ServiceProviderConfig of RFC 7643 section 5, as `serviceProviderConfig` writes it. */
const ServiceProviderConfigJson = z.strictObject({
  schemas: z.array(z.string()),
  patch: z.strictObject({ supported: z.boolean() }),
  bulk: z.strictObject({
    supported: z.boolean(),
    maxOperations: z.number(),
    maxPayloadSize: z.number(),
  }),
  filter: z.strictObject({ supported: z.boolean(), maxResults: z.number() }),
  changePassword: z.strictObject({ supported: z.boolean() }),
  sort: z.strictObject({ supported: z.boolean() }),
  etag: z.strictObject({ supported: z.boolean() }),
  authenticationSchemes: z.array(
    z.strictObject({
      type: z.string(),
      name: z.string(),
      description: z.string(),
      primary: z.boolean(),
    }),
  ),
  [NS_AUTHTEMPO_SCIM_LIMITS]: z.strictObject({
    groupMembersMax: z.number(),
    membersPerRequestMax: z.number(),
    roleRecomputeMax: z.number(),
  }),
  meta,
});

/** A ResourceType of RFC 7643 section 6. */
const ResourceTypeJson = z.strictObject({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  description: z.string(),
  schema: z.string(),
  schemaExtensions: z
    .array(z.strictObject({ schema: z.string(), required: z.boolean() }))
    .optional(),
  meta,
});

/** One attribute definition of RFC 7643 section 7. */
const attributeFields = {
  name: z.string(),
  type: z.enum(["string", "boolean", "complex", "reference", "binary"]),
  multiValued: z.boolean(),
  required: z.boolean(),
  caseExact: z.boolean(),
  mutability: z.enum(["readWrite", "readOnly", "immutable", "writeOnly"]),
  returned: z.enum(["always", "default", "never", "request"]),
  uniqueness: z.enum(["none", "server", "global"]),
  referenceTypes: z.array(z.string()).optional(),
  canonicalValues: z.array(z.string()).optional(),
};
const SubAttributeJson = z.strictObject(attributeFields);
const AttributeJson = z.strictObject({
  ...attributeFields,
  subAttributes: z.array(SubAttributeJson).optional(),
});

/** A Schema of RFC 7643 section 7. */
const SchemaJson = z.strictObject({
  schemas: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  attributes: z.array(AttributeJson),
  meta,
});

/** The ListResponse of RFC 7644 section 3.4.2 over one resource schema. */
const listOf = <T extends z.ZodType>(resource: T) =>
  z.strictObject({
    schemas: z.array(z.string()),
    totalResults: z.number(),
    startIndex: z.number(),
    itemsPerPage: z.number(),
    Resources: z.array(resource),
  });

const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** The value of one attribute of a User answer, by the facts of its rule in patch.ts. */
function userValue(rule: AttrRule): z.ZodType {
  const facts = rule.facts;
  const simple = facts?.type === "boolean" ? z.boolean() : z.string();
  if (facts?.type !== "complex" || rule.subs === null) return simple;
  const item = z.strictObject(
    Object.fromEntries(
      [...rule.subs.values()].map((sub) => [
        sub.name,
        (sub.facts.type === "boolean" ? z.boolean() : z.string()).optional(),
      ]),
    ),
  );
  return facts.multiValued ? z.array(item) : item;
}

/**
 * A User of RFC 7643 section 4.1, as `toScimUser` writes it (plan 12d Task
 * 10). Each attribute comes from the tables of patch.ts, so the answer and
 * the parser read one table.
 */
const UserJson = z.strictObject({
  ...Object.fromEntries(
    [...USER_RULES.values()]
      .filter((r) => r.facts !== null && r.name !== "groups")
      .map((r) => [r.name, userValue(r).optional()]),
  ),
  schemas: z.array(z.string()),
  id: z.string(),
  externalId: z.string().optional(),
  userName: z.string(),
  active: z.boolean(),
  groups: z
    .array(
      z.strictObject({
        value: z.string(),
        $ref: z.string(),
        display: z.string(),
        type: z.string(),
      }),
    )
    .optional(),
  [NS_SCIM_ENTERPRISE]: z
    .strictObject(
      Object.fromEntries(
        [...ENTERPRISE_RULES.values()].map((r) => [r.name, userValue(r).optional()]),
      ),
    )
    .optional(),
  meta: z.strictObject({
    resourceType: z.string(),
    created: z.iso.datetime(),
    lastModified: z.iso.datetime(),
    location: z.string(),
    version: z.string(),
  }),
});

/**
 * The User answer after `attributes` or `excludedAttributes` (RFC 7644
 * section 3.9): each attribute but id, schemas, and meta may be left out.
 * A complex attribute may hold part of its sub-attributes, as each
 * sub-attribute is optional.
 */
const UserSelectedJson = UserJson.partial().required({ schemas: true, id: true, meta: true });

/**
 * A Group of RFC 7643 section 4.2, as `toScimGroup` writes it (plan 12d
 * Task 11). Each member holds `value`, `$ref`, and `type` (ruling 53 P6),
 * and no `display`.
 */
const GroupJson = z.strictObject({
  schemas: z.array(z.string()),
  id: z.string(),
  externalId: z.string().optional(),
  displayName: z.string(),
  members: z
    .array(z.strictObject({ value: z.string(), $ref: z.string(), type: z.literal("User") }))
    .optional(),
  meta: z.strictObject({
    resourceType: z.string(),
    created: z.iso.datetime(),
    lastModified: z.iso.datetime(),
    location: z.string(),
    version: z.string(),
  }),
});

/** The Group answer after `attributes` or `excludedAttributes`, as for a User. */
const GroupSelectedJson = GroupJson.partial().required({ schemas: true, id: true, meta: true });

/** The refusals of the design's 9.5: the route answers only the SCIM error, with 501. */
const NOT_SUPPORTED = { answer: { kind: "scim", schema: null } } as const;

/** The contract of `routes/scim.ts` (plan 12d Task 9). */
export const SCIM_CONTRACT = {
  "GET /scim/tokens": {
    query: { schema: scimTokenListQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ tokens: z.array(ScimTokenJson) }) },
  },
  "POST /scim/tokens/create": {
    body: jsonBody(scimTokenCreateBody),
    answer: { kind: "json", schema: scimTokenCreated },
  },
  "POST /scim/tokens/revoke": {
    body: jsonBody(scimTokenIdBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "GET /scim/v2/ServiceProviderConfig": {
    answer: { kind: "scim", schema: ServiceProviderConfigJson },
  },
  "GET /scim/v2/ResourceTypes": { answer: { kind: "scim", schema: listOf(ResourceTypeJson) } },
  "GET /scim/v2/ResourceTypes/:id": { answer: { kind: "scim", schema: ResourceTypeJson } },
  "GET /scim/v2/Schemas": { answer: { kind: "scim", schema: listOf(SchemaJson) } },
  "GET /scim/v2/Schemas/:id": { answer: { kind: "scim", schema: SchemaJson } },
  "GET /scim/v2/Users": { answer: { kind: "scim", schema: listOf(UserSelectedJson) } },
  "POST /scim/v2/Users": { answer: { kind: "scim", schema: UserJson } },
  "GET /scim/v2/Users/:id": { answer: { kind: "scim", schema: UserSelectedJson } },
  "PUT /scim/v2/Users/:id": { answer: { kind: "scim", schema: UserJson } },
  "PATCH /scim/v2/Users/:id": { answer: { kind: "scim", schema: UserJson } },
  // A delete answers 204 with no body (RFC 7644 section 3.6).
  "DELETE /scim/v2/Users/:id": { answer: { kind: "scim", schema: z.null() } },
  "GET /scim/v2/Groups": { answer: { kind: "scim", schema: listOf(GroupSelectedJson) } },
  "POST /scim/v2/Groups": { answer: { kind: "scim", schema: GroupJson } },
  "GET /scim/v2/Groups/:id": { answer: { kind: "scim", schema: GroupSelectedJson } },
  "PUT /scim/v2/Groups/:id": { answer: { kind: "scim", schema: GroupJson } },
  // A PATCH answers 204 with no body, or the Group when the query asks for attributes.
  "PATCH /scim/v2/Groups/:id": { answer: { kind: "scim", schema: GroupSelectedJson } },
  "DELETE /scim/v2/Groups/:id": { answer: { kind: "scim", schema: z.null() } },
  "POST /scim/v2/Bulk": NOT_SUPPORTED,
  "GET /scim/v2/Me": NOT_SUPPORTED,
  "POST /scim/v2/.search": NOT_SUPPORTED,
  "POST /scim/v2/Users/.search": NOT_SUPPORTED,
  "POST /scim/v2/Groups/.search": NOT_SUPPORTED,
} as const satisfies Record<string, RouteContract>;
