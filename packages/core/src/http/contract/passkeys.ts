import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import {
  CreationOptionsJson,
  OkAnswer,
  PasskeySummary,
  RequestOptionsJson,
  SessionAnswer,
} from "./shapes.js";
import type { RouteContract } from "./types.js";

/** The browser's `PublicKeyCredential.toJSON()`. Only the fields the engine reads are checked; the seam checks the rest. */
export const credentialJson = z
  .object({
    id: z.string().min(1).max(1024),
    response: z.object({ clientDataJSON: z.string().min(1).max(16_384) }).loose(),
  })
  .loose();

// The engine applies the passkey name rule (plan 12a Task 19), so an api caller meets it too.
export const registerVerifyBody = z.object({
  response: credentialJson,
  name: z.string().optional(),
});
export const authenticateVerifyBody = z.object({ response: credentialJson });
export const deleteBody = z.object({ id: z.string().min(1).max(64) });
export const renameBody = z.strictObject({ id: z.string().min(1).max(64), name: z.string() });

const passkeyAnswer = z.strictObject({ passkey: PasskeySummary });

/** The contract of `routes/passkeys.ts` (plan 11g). */
export const PASSKEYS_CONTRACT = {
  "POST /passkey/register/options": { answer: { kind: "json", schema: CreationOptionsJson } },
  "POST /passkey/register/verify": {
    body: { schema: registerVerifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: passkeyAnswer },
  },
  "POST /passkey/authenticate/options": { answer: { kind: "json", schema: RequestOptionsJson } },
  "POST /passkey/authenticate/verify": {
    body: { schema: authenticateVerifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SessionAnswer },
  },
  "GET /passkeys": {
    answer: { kind: "json", schema: z.strictObject({ passkeys: z.array(PasskeySummary) }) },
  },
  "POST /passkeys/delete": {
    body: { schema: deleteBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /passkeys/rename": {
    body: { schema: renameBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: passkeyAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
