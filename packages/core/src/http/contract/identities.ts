import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

// An identity id is a core id; the cap bounds the body.
export const unlinkBody = z.strictObject({ id: z.string().min(1).max(64) });

/** One linked identity. `email` is set for the `email` identity only; a provider's subject is never answered. */
export const IdentityEntryJson = z.strictObject({
  id: z.string(),
  provider: z.string(),
  email: z.string().optional(),
  linkedAt: z.iso.datetime(),
  canUnlink: z.boolean(),
});

/** The ways in of the signed-in person, as `listIdentities` answers them. */
export const IdentityListJson = z.strictObject({
  identities: z.array(IdentityEntryJson),
  password: z.boolean(),
  passkeys: z.number().int().min(0),
});

/** The contract of `routes/identities.ts` (plan 11g). */
export const IDENTITIES_CONTRACT = {
  "GET /identities": { answer: { kind: "json", schema: IdentityListJson } },
  "POST /identities/unlink": {
    body: { schema: unlinkBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
