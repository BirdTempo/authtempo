import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { credentialJson } from "./passkeys.js";
import { RequestOptionsJson, SentAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** One proof of the three. The route holds the body to exactly one, and refuses `code` beside a passkey. */
export const reauthBody = z.strictObject({
  // The engine refuses more than 128 code points; this cap bounds the body.
  password: z.string().max(1024).optional(),
  emailCode: z.string().min(1).max(16).optional(),
  passkey: credentialJson.optional(),
  code: z.string().min(1).max(64).optional(),
});

/** The contract of `routes/reauth.ts` (plan 11g). */
export const REAUTH_CONTRACT = {
  "POST /reauth": {
    body: { schema: reauthBody, media: ["json"], parsedBy: "zod" },
    // The end of the fresh window. The session token stays.
    answer: { kind: "json", schema: z.strictObject({ freshUntil: z.iso.datetime() }) },
  },
  "POST /reauth/passkey/options": { answer: { kind: "json", schema: RequestOptionsJson } },
  "POST /reauth/email": { answer: { kind: "json", schema: SentAnswer } },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
