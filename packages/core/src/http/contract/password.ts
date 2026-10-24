import { z } from "zod";
import { PASSWORD_RESET_TOKEN_RE, PASSWORD_VERIFY_TOKEN_RE } from "../../engine/password.js";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SentAnswer, SignedInAnswer, TwoFactorChallenge, UserJson } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const signUpBody = z.object({
  email: z.string().max(320),
  // The engine refuses more than 128 code points; this cap only bounds the body.
  password: z.string().max(1024),
  name: z.string().max(200).optional(),
  // Plan 12i Task 2: only with `username` on and `uniformSignUp` off (ruling
  // 16 M1). The engine applies NFKC and the bounds.
  username: z.string().max(256).optional(),
});

export const signInBody = z.object({
  email: z.string().max(320),
  // The engine refuses more than 128 code points; this cap only bounds the body.
  password: z.string().max(1024),
  // Plan 9f: a native app's trust token (a browser sends the cookie), and the landing path after a challenge.
  trustDevice: z.string().max(64).optional(),
  next: z.string().max(2048).optional(),
});

export const tokenBody = z.object({ token: z.string().max(64) });

export const resetRequestBody = z.object({
  email: z.string().max(320),
  next: z.string().max(2048).optional(),
});

export const resendBody = z.object({ email: z.string().max(320) });

export const resetBody = z.object({
  token: z.string().max(64),
  // The engine refuses more than 128 code points; this cap only bounds the body.
  password: z.string().max(1024),
  // Plan 12c: a native app's trust token; a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});

export const changeBody = z.object({
  currentPassword: z.string().max(1024).optional(),
  newPassword: z.string().max(1024),
});

/** The refusals the reset page shows. The link is still valid after each. */
export const RESET_PAGE_ERRORS = [
  "password_policy",
  "password_breached",
  "breach_check_unavailable",
] as const;

/** The query of the verify link. The route holds the token to the engine's form. */
export const verifyQuery = z.object({ token: z.string().regex(PASSWORD_VERIFY_TOKEN_RE) });

/** The query of the reset link: the token, and the refusal the page shows after a refused password. */
export const resetQuery = z.object({
  token: z.string().regex(PASSWORD_RESET_TOKEN_RE),
  error: z.enum(RESET_PAGE_ERRORS).optional(),
});

/** The sign-up answer, as each password config answers it (plan 12b): uniform, pending, or signed in. */
const signUpAnswer = z.union([
  SentAnswer,
  z.strictObject({ user: UserJson, verifyRequired: z.literal(true) }),
  SignedInAnswer,
]);

const signInAnswer = z.union([SignedInAnswer, TwoFactorChallenge]);

/** The contract of `routes/password.ts` (plan 11g). */
export const PASSWORD_CONTRACT = {
  "POST /password/sign-up": {
    body: { schema: signUpBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: signUpAnswer },
  },
  "POST /password/sign-in": {
    body: { schema: signInBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: signInAnswer },
  },
  "GET /password/verify": {
    query: { schema: verifyQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /password/verify": {
    body: { schema: tokenBody, media: ["json", "form"], parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ verified: z.literal(true) }) },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /password/verify/resend": {
    body: { schema: resendBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "POST /password/reset/request": {
    body: { schema: resetRequestBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "GET /password/reset": {
    query: { schema: resetQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /password/reset": {
    body: { schema: resetBody, media: ["json", "form"], parsedBy: "zod" },
    answer: { kind: "json", schema: signInAnswer },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /password/change": {
    body: { schema: changeBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
