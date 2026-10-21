import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { id } from "./organizations.js";
import { OkAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

// Strict: a key that core does not read answers invalid_body.
export const domainListQuery = z.strictObject({ organizationId: id });
/** The engine holds the domain to its form; 253 is the longest DNS name. */
export const domainAddBody = z.strictObject({
  organizationId: id,
  domain: z.string().min(1).max(253),
});
export const domainIdBody = z.strictObject({ id });
export const domainUpdateBody = z.strictObject({
  id,
  connectionId: id.nullable().optional(),
  enforce: z.boolean().optional(),
  includeSubdomains: z.boolean().optional(),
});

/** One domain, as `SsoDomainSummary` answers it. `record` is the TXT record to publish while the row is pending. */
export const DomainJson = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  domain: z.string(),
  record: z
    .strictObject({ name: z.string(), type: z.literal("TXT"), value: z.string() })
    .nullable(),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  checkedAt: z.iso.datetime().nullable(),
  connectionId: z.string().nullable(),
  enforce: z.boolean(),
  includeSubdomains: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
});

const domainAnswer = z.strictObject({ domain: DomainJson });
const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** The contract of `routes/sso.ts` (plan 12d Task 2). */
export const SSO_CONTRACT = {
  "GET /sso/domains": {
    query: { schema: domainListQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ domains: z.array(DomainJson) }) },
  },
  "POST /sso/domains/add": {
    body: jsonBody(domainAddBody),
    answer: { kind: "json", schema: domainAnswer },
  },
  "POST /sso/domains/verify": {
    body: jsonBody(domainIdBody),
    answer: { kind: "json", schema: domainAnswer },
  },
  "POST /sso/domains/update": {
    body: jsonBody(domainUpdateBody),
    answer: { kind: "json", schema: domainAnswer },
  },
  "POST /sso/domains/delete": {
    body: jsonBody(domainIdBody),
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
