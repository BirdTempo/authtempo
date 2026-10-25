import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { SentAnswer, SignedInAnswer, SignInAnswer, TwoFactorChallenge } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const requestBody = z.object({ email: z.string().max(320) });
export const verifyBody = z.object({
  email: z.string().max(320),
  code: z.string().max(16),
  // Plan 12c: a native app's trust token; a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});
export const resetBody = z.object({
  email: z.string().max(320),
  code: z.string().max(16),
  // The engine refuses more than 128 code points; this cap only bounds the body.
  password: z.string().max(1024),
  // Plan 12c: a native app's trust token; a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});

/**
 * A verify and a reset answer the session, or the challenge of a user with
 * the second factor on. The verify carries `via` (plan 12i); the reset does not.
 */
const signInAnswer = z.union([SignInAnswer, TwoFactorChallenge]);
const resetAnswer = z.union([SignedInAnswer, TwoFactorChallenge]);

/** The contract of `routes/email-otp.ts` (plan 11g). */
export const EMAIL_OTP_CONTRACT = {
  "POST /otp/request": {
    body: { schema: requestBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "POST /otp/verify": {
    body: { schema: verifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: signInAnswer },
  },
  "POST /otp/reset/request": {
    body: { schema: requestBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "POST /otp/reset": {
    body: { schema: resetBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: resetAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
