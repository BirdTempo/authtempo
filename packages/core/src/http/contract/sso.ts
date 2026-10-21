import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { id } from "./organizations.js";
import { OkAnswer } from "./shapes.js";
import { callbackQuery, startQuery } from "./social.js";
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

/**
 * The fields of a connection write. The schema holds the types and loose
 * bounds; the engine holds each rule and answers `invalid_body` with a
 * message that names the field. 200 000 bounds the IdP metadata of Task 8.
 */
const text = z.string().max(4096);
const connectionFields = {
  label: text.optional(),
  enabled: z.boolean().optional(),
  jit: z.boolean().optional(),
  defaultRole: text.optional(),
  mfa: z
    .strictObject({
      amr: z.array(text).max(64).optional(),
      acr: z.array(text).max(64).optional(),
      authnContext: z.array(text).max(64).optional(),
    })
    .nullable()
    .optional(),
  scimRoles: z.record(text, text).nullable().optional(),
  issuer: text.optional(),
  clientId: text.optional(),
  clientSecret: text.optional(),
  scope: text.optional(),
  endpoints: z
    .strictObject({ authorizeUrl: text, tokenUrl: text, jwksUrl: text })
    .nullable()
    .optional(),
  idpMetadata: z.string().max(200_000).optional(),
  idpEntityId: text.optional(),
  ssoUrl: text.optional(),
  certificates: z.array(z.string().max(65_536)).max(8).optional(),
  subjectAttribute: text.nullable().optional(),
  attributes: z.strictObject({ email: text, name: text.nullable().optional() }).optional(),
};
export const connectionListQuery = z.strictObject({ organizationId: id });
export const connectionCreateBody = z.strictObject({
  organizationId: id,
  kind: z.enum(["oidc", "saml"]),
  ...connectionFields,
  label: text,
});
/** `organizationId` and `kind` may come, so the engine answers that they never change. */
export const connectionUpdateBody = z.strictObject({
  id,
  organizationId: id.optional(),
  kind: z.enum(["oidc", "saml"]).optional(),
  ...connectionFields,
});
export const connectionIdBody = z.strictObject({ id });

/** One connection, as `SsoConnectionSummary` answers it. It never holds the client secret. */
export const ConnectionJson = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  kind: z.enum(["oidc", "saml"]),
  label: z.string(),
  enabled: z.boolean(),
  jit: z.boolean(),
  defaultRole: z.string(),
  mfa: z
    .strictObject({
      amr: z.array(z.string()),
      acr: z.array(z.string()),
      authnContext: z.array(z.string()),
    })
    .nullable(),
  scimRoles: z.record(z.string(), z.string()).nullable(),
  oidc: z
    .strictObject({
      issuer: z.string(),
      clientId: z.string(),
      scope: z.string(),
      endpoints: z
        .strictObject({ authorizeUrl: z.string(), tokenUrl: z.string(), jwksUrl: z.string() })
        .nullable(),
    })
    .optional(),
  saml: z
    .strictObject({
      idpEntityId: z.string(),
      ssoUrl: z.string(),
      certificates: z.array(z.strictObject({ notAfter: z.iso.datetime() })),
      subjectAttribute: z.string().nullable(),
      attributes: z.strictObject({ email: z.string(), name: z.string().nullable() }),
      spEntityId: z.string(),
      acsUrl: z.string(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const connectionAnswer = z.strictObject({ connection: ConnectionJson });

/**
 * The body of the discovery (plan 12d Task 4). Not strict: a form may carry
 * the name of its button. `next` is the landing path that a form passes on
 * to the start.
 */
export const discoverBody = z.object({
  email: z.string().max(320),
  next: z.string().max(2048).optional(),
});

/** The answer of the discovery: the start path of the connection, or no SSO. */
const discoverAnswer = z.union([
  z.strictObject({ sso: z.literal(true), start: z.string() }),
  z.strictObject({ sso: z.literal(false) }),
]);
const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** The contract of `routes/sso.ts` (plan 12d Tasks 2 and 3). */
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
  "GET /sso/connections": {
    query: { schema: connectionListQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ connections: z.array(ConnectionJson) }) },
  },
  "POST /sso/connections/create": {
    body: jsonBody(connectionCreateBody),
    answer: { kind: "json", schema: connectionAnswer },
  },
  "POST /sso/connections/update": {
    body: jsonBody(connectionUpdateBody),
    answer: { kind: "json", schema: connectionAnswer },
  },
  "POST /sso/connections/delete": {
    body: jsonBody(connectionIdBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /sso/discover": {
    body: { schema: discoverBody, media: ["json", "form"], parsedBy: "zod" },
    // JSON: the answer. A form: a 303 to the start, or to the error page of the app.
    answer: { kind: "json", schema: discoverAnswer },
    alt: { kind: "redirect", param: "auth_error", status: 303 },
  },
  "GET /sso/:connectionId/start": {
    query: { schema: startQuery, parsedBy: "hand" },
    answer: { kind: "redirect", param: "auth_error" },
  },
  "GET /sso/:connectionId/callback": {
    query: { schema: callbackQuery, parsedBy: "hand" },
    answer: { kind: "redirect", param: "auth_error" },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
