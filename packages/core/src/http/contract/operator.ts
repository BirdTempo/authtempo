import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

/**
 * The body of a rewrap (plan 11c2): `limit`, a whole number, and `after`, the
 * cursor of the last answer. An empty body is `{}`. The engine refuses a
 * cursor that is not `totp:<id>` or `jwk:<id>`.
 */
export const rewrapBody = z.strictObject({
  limit: z.number().int().optional(),
  after: z.string().optional(),
});

/** The row count of one secret version, as `secretsStatus` answers it. */
const SecretVersionCountJson = z.strictObject({
  version: z.number().int(),
  configured: z.boolean(),
  current: z.boolean(),
  totpSecrets: z.number().int(),
  backupCodes: z.number().int(),
  signingKeys: z.number().int(),
  emailCodes: z.number().int(),
});

/**
 * The contract of `routes/operator.ts` (plans 11g and 11c2). The rotation
 * names the new signing key. The three routes of 11c2 answer counts, key
 * names, and versions, never a sealed value, a hash, or a config value.
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
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
