import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { RequestOptionsJson, SentAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** The sign-in's length bound applies in `checkUserPassword`; this cap only bounds the body. */
const passwordField = z.string().max(1024);
export const passwordBody = z.object({ password: passwordField });
// `response` is a WebAuthn assertion; the engine reads only the fields that the seam checks.
export const passkeyEnableBody = z.object({ password: passwordField, response: z.unknown() });
export const disableBody = z.object({
  method: z.enum(["passkey", "email"]),
  password: passwordField,
});
export const challengeBody = z.object({ challenge: z.string().max(64) });

const METHODS = ["totp", "passkey", "email"] as const;

/** A method's enable: the methods that are on, and the backup codes, answered once with the first method (else empty). */
export const MethodEnabledJson = z.strictObject({
  methods: z.array(z.enum(METHODS)),
  backupCodes: z.array(z.string()),
});

const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** The contract of `routes/second-factor.ts` (plan 11g). */
export const SECOND_FACTOR_CONTRACT = {
  "POST /second-factor/passkey/enable": {
    body: jsonBody(passkeyEnableBody),
    answer: { kind: "json", schema: MethodEnabledJson },
  },
  "POST /second-factor/passkey/options": {
    body: jsonBody(challengeBody),
    answer: { kind: "json", schema: RequestOptionsJson },
  },
  "POST /second-factor/disable": {
    body: jsonBody(disableBody),
    // The methods that stay on. An empty list means the factor is off.
    answer: {
      kind: "json",
      schema: z.strictObject({ ok: z.literal(true), methods: z.array(z.enum(METHODS)) }),
    },
  },
  "POST /second-factor/email/enable": {
    body: jsonBody(passwordBody),
    answer: { kind: "json", schema: MethodEnabledJson },
  },
  "POST /second-factor/email/send": {
    body: jsonBody(challengeBody),
    answer: { kind: "json", schema: SentAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
