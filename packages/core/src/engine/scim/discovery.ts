/**
 * The discovery documents of the SCIM server (plan 12d Task 9 Behavior 9,
 * RFC 7644 section 4, RFC 7643 sections 5 to 7). The Schemas come from the
 * attribute tables of `patch.ts` (rulings 23 and 24 of plan 12d). The parser
 * and these documents read one table, so they cannot drift.
 */

import type { ResolvedConfig } from "../../config.js";
import {
  type AttrFacts,
  type AttrRule,
  ENTERPRISE_RULES,
  GROUP_RULES,
  NS_SCIM_ENTERPRISE,
  NS_SCIM_GROUP,
  NS_SCIM_USER,
  USER_RULES,
} from "./patch.js";
import { SCIM_PAGE_MAX } from "./select.js";

export const NS_SCIM_SERVICE_PROVIDER_CONFIG =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const NS_SCIM_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const NS_SCIM_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";
export const NS_SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

/** The base URL of the SCIM server: `<baseURL><basePath>/scim/v2`. */
export function scimBase(config: ResolvedConfig): string {
  return `${config.baseURL}${config.basePath}/scim/v2`;
}

/**
 * The ServiceProviderConfig (RFC 7643 section 5). Core serves PATCH, a
 * filter subset, and ETags; it has no bulk, no sort, and no password
 * change. `filter.maxResults` is the page bound of `pageParams`.
 */
export function serviceProviderConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    schemas: [NS_SCIM_SERVICE_PROVIDER_CONFIG],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_PAGE_MAX },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "A SCIM token of the organization as the bearer.",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${scimBase(config)}/ServiceProviderConfig`,
    },
  };
}

/** The two resource types (RFC 7643 section 6). A User may carry the enterprise extension. */
export function resourceTypes(config: ResolvedConfig): Record<string, unknown>[] {
  const at = (id: string) => ({
    resourceType: "ResourceType",
    location: `${scimBase(config)}/ResourceTypes/${id}`,
  });
  return [
    {
      schemas: [NS_SCIM_RESOURCE_TYPE],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "User Account",
      schema: NS_SCIM_USER,
      schemaExtensions: [{ schema: NS_SCIM_ENTERPRISE, required: false }],
      meta: at("User"),
    },
    {
      schemas: [NS_SCIM_RESOURCE_TYPE],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      description: "Group",
      schema: NS_SCIM_GROUP,
      meta: at("Group"),
    },
  ];
}

/** One attribute definition of RFC 7643 section 7, from its facts. */
function definition(name: string, facts: AttrFacts, subs: Record<string, unknown>[] | null) {
  return {
    name,
    type: facts.type,
    multiValued: facts.multiValued,
    required: facts.required,
    caseExact: facts.caseExact,
    mutability: facts.mutability,
    returned: facts.returned,
    uniqueness: facts.uniqueness,
    ...(facts.referenceTypes ? { referenceTypes: [...facts.referenceTypes] } : {}),
    ...(facts.canonicalValues ? { canonicalValues: [...facts.canonicalValues] } : {}),
    ...(subs ? { subAttributes: subs } : {}),
  };
}

/** The attributes of one table that a Schema lists: each rule with facts, in table order. */
function attributesOf(rules: ReadonlyMap<string, AttrRule>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rule of rules.values()) {
    if (rule.facts === null) continue;
    const subs =
      rule.subs === null
        ? null
        : [...rule.subs.values()].map((sub) => definition(sub.name, sub.facts, null));
    out.push(definition(rule.name, rule.facts, subs));
  }
  return out;
}

/** The three Schemas of RFC 7643 section 8.7.1 that core serves, in that order. */
export function scimSchemas(config: ResolvedConfig): Record<string, unknown>[] {
  const schema = (id: string, name: string, description: string, rules: typeof USER_RULES) => ({
    schemas: [NS_SCIM_SCHEMA],
    id,
    name,
    description,
    attributes: attributesOf(rules),
    meta: { resourceType: "Schema", location: `${scimBase(config)}/Schemas/${id}` },
  });
  return [
    schema(NS_SCIM_USER, "User", "User Account", USER_RULES),
    schema(NS_SCIM_GROUP, "Group", "Group", GROUP_RULES),
    schema(NS_SCIM_ENTERPRISE, "EnterpriseUser", "Enterprise User", ENTERPRISE_RULES),
  ];
}

/**
 * A ListResponse of every resource (RFC 7644 section 3.4.2). The discovery
 * lists use it with no paging: section 4 says that their query parameters
 * are ignored.
 */
export function listResponse(resources: readonly unknown[]): Record<string, unknown> {
  return {
    schemas: [NS_SCIM_LIST],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: [...resources],
  };
}
