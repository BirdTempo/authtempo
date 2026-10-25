import { z } from "zod";
import { OPERATOR_ACTIONS, REASON_MAX } from "../../engine/operator/audit.js";
import { PROOF_METHODS, REFERENCE_MAX } from "../../engine/operator/second-factor.js";
import { END_ALL_LIMIT } from "../../engine/operator/sessions.js";
import { AUDIT_ACTOR_KINDS } from "../../schema.js";
import type { RouteKey } from "../route-list.js";
import { DomainJson } from "./sso.js";
import type { RouteContract } from "./types.js";

/**
 * The body of a rewrap (plan 11c2): `limit`, a whole number, and `after`, the
 * cursor of the last answer. `callBudget` is the storage calls of the call
 * (ruling 33 of plan 12d). An empty body is `{}`. The engine refuses a
 * cursor that is not `totp:<id>`, `jwk:<id>`, or `ssoConnection:<id>`.
 */
export const rewrapBody = z.strictObject({
  limit: z.number().int().optional(),
  after: z.string().optional(),
  callBudget: z.number().int().optional(),
});

/**
 * The body of an impersonation start (plan 12f Task 11): the target and the
 * operator's reason. The engine checks the reason (1 to 500 characters, no
 * control character); the id bound keeps a read short.
 */
export const impersonateBody = z.strictObject({
  userId: z.string().min(1).max(64),
  reason: z.string(),
});

/** The body of a stop: an optional reason. An empty body is `{}`. */
export const impersonateStopBody = z.strictObject({ reason: z.string().optional() });

/** The row count of one secret version, as `secretsStatus` answers it. */
const SecretVersionCountJson = z.strictObject({
  version: z.number().int(),
  configured: z.boolean(),
  current: z.boolean(),
  totpSecrets: z.number().int(),
  backupCodes: z.number().int(),
  signingKeys: z.number().int(),
  emailCodes: z.number().int(),
  ssoClientSecrets: z.number().int(),
  stateData: z.number().int(),
});

/** A user id or a cursor. A core id has 26 characters; the compat package keeps longer ids, up to 64. */
const operatorId = z.string().min(1).max(64);
/** A page size as a query string. The engine holds it to 1 to 100. */
const pageLimit = z.string().regex(/^[1-9][0-9]{0,2}$/);
/** The reason of an act. The engine also refuses a control character and a lone surrogate. */
const reason = z.string().min(1).max(REASON_MAX);

/**
 * The queries of the four reads (plan 12f Task 10). Each query is a strict
 * object of strings, so a key that no schema names answers `invalid_body`.
 * The search takes exactly one of `email`, `emailPrefix`, and `id`; the
 * engine holds that rule.
 */
export const usersQuery = z.strictObject({
  after: operatorId.optional(),
  limit: pageLimit.optional(),
});
export const searchQuery = z.strictObject({
  email: z.string().min(1).max(320).optional(),
  emailPrefix: z.string().min(1).max(254).optional(),
  id: operatorId.optional(),
  after: operatorId.optional(),
  limit: pageLimit.optional(),
});
export const userQuery = z.strictObject({ userId: operatorId });
export const auditQuery = z.strictObject({
  targetUserId: operatorId.optional(),
  after: operatorId.optional(),
  limit: pageLimit.optional(),
});

/**
 * The bodies of the seven writes (plan 12f Task 10): JSON only, because a
 * boolean and a proof object have no form text. `until` is the end of a
 * ban as a date-time with a zone; `checkedAt` is the time of the identity
 * check. The engine holds both to its date rule.
 */
export const userReasonBody = z.strictObject({ userId: operatorId, reason });
export const banBody = z.strictObject({
  userId: operatorId,
  reason,
  until: z.string().min(1).max(64).optional(),
});
export const platformRoleBody = z.strictObject({
  userId: operatorId,
  grant: z.boolean(),
  reason,
});
export const factorDisableBody = z.strictObject({
  userId: operatorId,
  reason,
  proof: z.strictObject({
    method: z.enum(PROOF_METHODS),
    reference: z.string().min(1).max(REFERENCE_MAX),
    checkedAt: z.string().min(1).max(64),
  }),
});
export const createAdminBody = z.strictObject({
  email: z.string().min(1).max(320),
  name: z.string().min(1).max(200).optional(),
  reason,
});
/** The operator's override of `enforce` (plan 12d deviation 5): the domain and the reason. */
export const enforceOffBody = z.strictObject({ domainId: operatorId, reason });

/**
 * The body of an operator create (plan 12f2 Task 5). `email` is required
 * and may be null, so a caller states the case of no address on purpose;
 * a null address needs `phone`, and an address takes no `phone` (ruling 12
 * of plan 12f2). The engine applies the address, phone, name, and image
 * rules; these caps bound the body. The schema is strict,
 * so `password`, `role`, the ban keys, and every other key answer
 * `invalid_body`: no operator path sets a credential.
 */
export const createUserBody = z.strictObject({
  email: z.string().min(1).max(320).nullable(),
  phone: z.string().min(1).max(32).optional(),
  emailVerified: z.boolean().optional(),
  name: z.string().max(400).nullable().optional(),
  image: z.string().max(4096).nullable().optional(),
  firstSignIn: z.enum(["invite", "reset", "none"]).optional(),
  reason,
});

/**
 * The body of an operator update (plan 12f2 Task 5): the user, a name or an
 * image or both, and the reason. Null clears a field. The engine applies
 * the name and image rules of plan 12a; these caps bound the body. The
 * schema is strict, so `password`, `email`, `emailVerified`, `role`, and
 * the ban keys answer `invalid_body`: no operator path sets them here.
 */
export const updateUserBody = z.strictObject({
  userId: operatorId,
  name: z.string().max(400).nullable().optional(),
  image: z.string().max(4096).nullable().optional(),
  reason,
});
export const endAllBody = z.strictObject({
  reason,
  limit: z.number().int().min(1).max(END_ALL_LIMIT.max).optional(),
});

/** One user as `api.operator.users` answers it: no hash, no sealed value, no token, no subject. */
const OperatorUserJson = z.strictObject({
  id: z.string(),
  /** Null for a user with no address (plan 12i). */
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  /** The username and the phone, or null (plan 12i). */
  username: z.string().nullable(),
  phone: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
  ban: z
    .strictObject({
      at: z.iso.datetime(),
      reason: z.string().nullable(),
      until: z.iso.datetime().nullable(),
    })
    .nullable(),
  platformOperator: z.boolean(),
  secondFactor: z.array(z.string()),
  sessions: z.number().int(),
  identities: z.array(z.string()),
});

const usersPage = z.strictObject({
  users: z.array(OperatorUserJson),
  next: z.string().nullable(),
});

/** One audit row (spec 26 item 8). `actorId` names a secret by its name, never by the secret. */
const OperatorAuditJson = z.strictObject({
  id: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  actorKind: z.enum(AUDIT_ACTOR_KINDS),
  actorId: z.string(),
  action: z.enum(OPERATOR_ACTIONS),
  targetUserId: z.string().nullable(),
  reason: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

/** The answer of each write but create-admin and the session ends: the id of its audit row. */
const auditAnswer = z.strictObject({ auditId: z.string() });
/** The ban and the revoke: `familyEndFailed` when `endFamilies` threw after the commit (ruling 37). */
const accessEndAnswer = z.strictObject({
  auditId: z.string(),
  familyEndFailed: z.literal(true).optional(),
});
const sessionsEnded = z.strictObject({
  ended: z.number().int(),
  more: z.boolean(),
  auditId: z.string(),
  familyEndFailed: z.literal(true).optional(),
});
const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/**
 * The contract of `routes/operator.ts` (plans 11g, 11c2, and 12f). The
 * rotation names the new signing key. The three routes of 11c2 answer
 * counts, key names, and versions, never a sealed value, a hash, or a
 * config value. The routes of 12f answer users, audit rows, and the id of
 * the audit row of each write. The create, the update, and the delete of
 * 12f2 answer the same id.
 */
export const OPERATOR_CONTRACT = {
  "POST /operator/keys/rotate": {
    answer: { kind: "json", schema: z.strictObject({ kid: z.string() }) },
  },
  "GET /operator/secrets/status": {
    answer: {
      kind: "json",
      schema: z.strictObject({ versions: z.array(SecretVersionCountJson) }),
    },
  },
  "POST /operator/secrets/rewrap": {
    body: { schema: rewrapBody, media: ["json"], parsedBy: "zod", optional: true },
    answer: {
      kind: "json",
      schema: z.strictObject({
        resealed: z.number().int(),
        failed: z.number().int(),
        skipped: z.number().int(),
        more: z.boolean(),
        next: z.string().nullable(),
      }),
    },
  },
  "GET /operator/info": {
    answer: {
      kind: "json",
      schema: z.strictObject({
        core: z.string(),
        schemaVersion: z.number().int(),
        configKeys: z.array(z.string()),
      }),
    },
  },
  "GET /operator/users": {
    query: { schema: usersQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: usersPage },
  },
  "GET /operator/users/search": {
    query: { schema: searchQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: usersPage },
  },
  "GET /operator/users/get": {
    query: { schema: userQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ user: OperatorUserJson }) },
  },
  "POST /operator/users/ban": {
    body: jsonBody(banBody),
    answer: { kind: "json", schema: accessEndAnswer },
  },
  "POST /operator/users/unban": {
    body: jsonBody(userReasonBody),
    answer: { kind: "json", schema: auditAnswer },
  },
  "POST /operator/users/platform-role": {
    body: jsonBody(platformRoleBody),
    answer: { kind: "json", schema: accessEndAnswer },
  },
  "POST /operator/users/second-factor/disable": {
    body: jsonBody(factorDisableBody),
    answer: { kind: "json", schema: auditAnswer },
  },
  "POST /operator/users/create-admin": {
    body: jsonBody(createAdminBody),
    answer: {
      kind: "json",
      schema: z.strictObject({ userId: z.string(), created: z.boolean(), auditId: z.string() }),
    },
  },
  // The mail kind is what the create mailed to the person, never a token or a link.
  "POST /operator/users/create": {
    body: jsonBody(createUserBody),
    answer: {
      kind: "json",
      schema: z.strictObject({
        userId: z.string(),
        mailed: z.enum(["invite", "reset"]).nullable(),
        auditId: z.string(),
      }),
    },
  },
  "POST /operator/users/update": {
    body: jsonBody(updateUserBody),
    answer: {
      kind: "json",
      schema: z.strictObject({ user: OperatorUserJson, auditId: z.string() }),
    },
  },
  // The ids of the solo organizations that went with the account.
  "POST /operator/users/delete": {
    body: jsonBody(userReasonBody),
    answer: {
      kind: "json",
      schema: z.strictObject({ organizations: z.array(z.string()), auditId: z.string() }),
    },
  },
  "POST /operator/sessions/end-user": {
    body: jsonBody(userReasonBody),
    answer: { kind: "json", schema: sessionsEnded },
  },
  "POST /operator/sessions/end-all": {
    body: jsonBody(endAllBody),
    answer: { kind: "json", schema: sessionsEnded },
  },
  "GET /operator/audit": {
    query: { schema: auditQuery, parsedBy: "zod" },
    answer: {
      kind: "json",
      schema: z.strictObject({ rows: z.array(OperatorAuditJson), next: z.string().nullable() }),
    },
  },
  // A bearer caller gets the token in the body; a cookie caller gets it in the cookie only.
  "POST /operator/impersonate": {
    body: { schema: impersonateBody, media: ["json"], parsedBy: "zod" },
    answer: {
      kind: "json",
      schema: z.strictObject({
        token: z.string().optional(),
        expiresAt: z.iso.datetime(),
        auditId: z.string(),
      }),
    },
  },
  // The domain after the override, with the id of its audit row (plan 12d).
  "POST /operator/sso/enforce-off": {
    body: jsonBody(enforceOffBody),
    answer: { kind: "json", schema: DomainJson.extend({ auditId: z.string() }) },
  },
  // restored: the answer set the session cookie back to the operator's token.
  "POST /operator/impersonate/stop": {
    body: { schema: impersonateStopBody, media: ["json"], parsedBy: "zod", optional: true },
    answer: {
      kind: "json",
      schema: z.strictObject({ auditId: z.string(), restored: z.boolean() }),
    },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
