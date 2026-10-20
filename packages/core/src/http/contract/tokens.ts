import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, UserJson } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** A statement set as a body holds it. The engine checks each name against the known set. */
const StatementsJson = z.record(z.string().max(64), z.array(z.string().max(64)).max(64));

export const createBody = z.object({
  // The engine refuses more than 80 code units; this cap only bounds the body.
  name: z.string().max(200),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  // `null` means no organization, the same as absent: the engine type takes both.
  organizationId: z.string().min(1).max(64).nullable().optional(),
  // Plan 12k. `null` means the user's own rights, the same as absent.
  permissions: StatementsJson.nullable().optional(),
  // The engine refuses more than 4096 bytes of JSON.
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const revokeBody = z.object({ id: z.string().min(1).max(64) });
/**
 * Plan 12k: the narrow-only update. A strict body, so a window or a quota
 * from a client answers `invalid_body`: only the app sets them, in process.
 */
export const updateBody = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().max(200).optional(),
  permissions: StatementsJson.nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

/** One API token of the user, as `publicApiToken` answers it. Never the hash, never the token. */
export const ApiTokenJson = z.strictObject({
  id: z.string(),
  name: z.string(),
  hint: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  organizationId: z.string().nullable(),
  permissions: z.record(z.string(), z.array(z.string())).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  rateLimit: z.strictObject({ seconds: z.number().int(), max: z.number().int() }).nullable(),
  remaining: z.number().int().nullable(),
  retired: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** The contract of `routes/tokens.ts` (plan 11g). */
export const TOKENS_CONTRACT = {
  "POST /tokens": {
    body: { schema: createBody, media: ["json"], parsedBy: "zod" },
    // The token is answered once. Every later answer holds the hint only.
    answer: {
      kind: "json",
      schema: z.strictObject({ token: z.string(), apiToken: ApiTokenJson }),
    },
  },
  "GET /tokens": {
    answer: { kind: "json", schema: z.strictObject({ tokens: z.array(ApiTokenJson) }) },
  },
  "POST /tokens/revoke": {
    body: { schema: revokeBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /tokens/update": {
    body: { schema: updateBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: ApiTokenJson },
  },
  "GET /tokens/current": {
    answer: { kind: "json", schema: z.strictObject({ user: UserJson, apiToken: ApiTokenJson }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
