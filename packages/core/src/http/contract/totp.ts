import { z } from "zod";
import { TWO_FACTOR_TOKEN_RE } from "../../engine/second-factor.js";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SessionJson, UserJson } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const codeBody = z.object({ code: z.string().max(64) });
/** The setup takes the password (plan 9f final fix wave, review I-1); the sign-in's length bound applies in `verifyPassword`. */
export const setupBody = z.object({ password: z.string().max(1024) });
export const verifyBody = z.object({
  challenge: z.string().max(64),
  code: z.string().max(16).optional(),
  backupCode: z.string().max(64).optional(),
  emailCode: z.string().max(16).optional(),
  // Plan 12c: a WebAuthn assertion; the engine reads only the fields that the seam checks.
  passkey: z.unknown().optional(),
  trustDevice: z.boolean().optional(),
});
/**
 * The challenge page's forms: the checkbox posts `trustDevice=1` when checked
 * and nothing else. `action` (plan 12c) is the send of an email code or the
 * trusted-device button.
 */
export const pageBody = z.object({
  challenge: z.string().max(64),
  code: z.string().max(16).optional(),
  backupCode: z.string().max(64).optional(),
  emailCode: z.string().max(16).optional(),
  trustDevice: z.literal("1").optional(),
  action: z.enum(["send-email", "trusted"]).optional(),
});

/**
 * The query of the challenge page (plan 12c): the challenge, the method the
 * page shows, `backup=1` for the backup code form, and the refusal after a
 * wrong code. The route holds the challenge to the engine's form.
 */
export const challengeQuery = z.object({
  challenge: z.string().regex(TWO_FACTOR_TOKEN_RE),
  method: z.enum(["totp", "email"]).optional(),
  backup: z.literal("1").optional(),
  error: z.literal("invalid_code").optional(),
});

/** The state of the second factor, as `totpStatus` answers it (plan 12c). */
export const TotpStatus = z.strictObject({
  enabled: z.boolean(),
  enabledAt: z.iso.datetime().nullable(),
  backupCodesLeft: z.number().int().min(0),
  trustedDevices: z.number().int().min(0),
  methods: z.array(z.enum(["totp", "passkey", "email"])),
  backupCodesVersion: z.number().int().nullable(),
});

/** The session of a verified challenge (plan 9f): the signed-in answer, the landing path, and the trust token when asked. */
export const TwoFactorSessionAnswer = z.strictObject({
  token: z.string(),
  user: UserJson,
  session: SessionJson,
  next: z.string(),
  backupCodesLeft: z.number().int().min(0),
  trustDevice: z.strictObject({ token: z.string(), expiresAt: z.iso.datetime() }).nullable(),
});

const codeInput = { schema: codeBody, media: ["json"], parsedBy: "zod" } as const;

/** The contract of `routes/totp.ts` (plan 11g). */
export const TOTP_CONTRACT = {
  "POST /totp/setup": {
    body: { schema: setupBody, media: ["json"], parsedBy: "zod" },
    // The secret, the key URI, and the backup codes, answered once. No route answers them again.
    answer: {
      kind: "json",
      schema: z.strictObject({
        secret: z.string(),
        uri: z.string(),
        backupCodes: z.array(z.string()),
      }),
    },
  },
  "POST /totp/enable": { body: codeInput, answer: { kind: "json", schema: TotpStatus } },
  "POST /totp/disable": { body: codeInput, answer: { kind: "json", schema: OkAnswer } },
  "POST /totp/backup-codes": {
    body: codeInput,
    answer: { kind: "json", schema: z.strictObject({ backupCodes: z.array(z.string()) }) },
  },
  "GET /totp": { answer: { kind: "json", schema: TotpStatus } },
  "POST /totp/devices/revoke": { answer: { kind: "json", schema: OkAnswer } },
  "POST /totp/verify": {
    body: { schema: verifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: TwoFactorSessionAnswer },
  },
  "GET /totp/challenge": {
    query: { schema: challengeQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /totp/challenge": {
    body: { schema: pageBody, media: ["json", "form"], parsedBy: "zod" },
    // The landing path after the factor, the page again after a wrong code, or the app's error page.
    answer: { kind: "redirect", param: "auth_error" },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
