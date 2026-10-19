import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, UserJson } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const createBody = z.object({
  // The engine refuses more than 80 code units; this cap only bounds the body.
  name: z.string().max(200),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  // `null` means no organization, the same as absent: the engine type takes both.
  organizationId: z.string().min(1).max(64).nullable().optional(),
});
export const revokeBody = z.object({ id: z.string().min(1).max(64) });

/** One API token of the user, as `publicApiToken` answers it. Never the hash, never the token. */
export const ApiTokenJson = z.strictObject({
  id: z.string(),
  name: z.string(),
  hint: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  organizationId: z.string().nullable(),
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
  "GET /tokens/current": {
    answer: { kind: "json", schema: z.strictObject({ user: UserJson, apiToken: ApiTokenJson }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
