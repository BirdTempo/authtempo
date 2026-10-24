import { z } from "zod";
import { PASSKEY_HINTS } from "../../primitives/passkey-hints.js";
import type { RouteKey } from "../route-list.js";
import {
  CreationOptionsJson,
  OkAnswer,
  PasskeySummary,
  RequestOptionsJson,
  SessionSignInAnswer,
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
/**
 * The hints of one ceremony (WebAuthn Level 3, plan 12i). The list replaces
 * the config's list. A value twice is a client bug, so it answers
 * `invalid_body`.
 */
const hintsField = z
  .array(z.enum(PASSKEY_HINTS))
  .max(PASSKEY_HINTS.length)
  .refine((list) => new Set(list).size === list.length, "a hint twice")
  .optional();
/** The body of both options routes. It is optional: an empty body is `{}`. */
export const optionsBody = z.strictObject({ hints: hintsField });
export const deleteBody = z.object({ id: z.string().min(1).max(64) });
export const renameBody = z.strictObject({ id: z.string().min(1).max(64), name: z.string() });

const passkeyAnswer = z.strictObject({ passkey: PasskeySummary });

/** The contract of `routes/passkeys.ts` (plan 11g). */
export const PASSKEYS_CONTRACT = {
  "POST /passkey/register/options": {
    body: { schema: optionsBody, media: ["json"], parsedBy: "zod", optional: true },
    answer: { kind: "json", schema: CreationOptionsJson },
  },
  "POST /passkey/register/verify": {
    body: { schema: registerVerifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: passkeyAnswer },
  },
  "POST /passkey/authenticate/options": {
    body: { schema: optionsBody, media: ["json"], parsedBy: "zod", optional: true },
    answer: { kind: "json", schema: RequestOptionsJson },
  },
  "POST /passkey/authenticate/verify": {
    body: { schema: authenticateVerifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SessionSignInAnswer },
  },
  // `rpId` and `userHandle` are the inputs of signalAllAcceptedCredentials (plan 12i).
  "GET /passkeys": {
    answer: {
      kind: "json",
      schema: z.strictObject({
        passkeys: z.array(PasskeySummary),
        rpId: z.string(),
        userHandle: z.string(),
      }),
    },
  },
  "POST /passkeys/delete": {
    body: { schema: deleteBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /passkeys/rename": {
    body: { schema: renameBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: passkeyAnswer },
  },
  // The related origins document of WebAuthn Level 3 (plan 12i).
  "GET /.well-known/webauthn": {
    answer: { kind: "json", schema: z.strictObject({ origins: z.array(z.string()) }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
