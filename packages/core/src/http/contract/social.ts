import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { SignInAnswer, TwoFactorChallenge } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** Apple posts these as a form. Every field is optional; the engine rules on what is missing. */
export const callbackBody = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(128).optional(),
  error: z.string().max(256).optional(),
  user: z.string().max(4096).optional(),
  id_token: z.string().max(8192).optional(),
});

/**
 * The app payload of plan 12i Task 19: the base64url of a UTF-8 JSON
 * object. 1366 characters hold 1024 bytes, the most that
 * `social.stateData.maxBytes` allows. The engine rules on the bytes.
 */
const stateData = z.string().max(1366).optional();

// Not strict: a form may carry the name of its button.
export const linkBody = z.object({ next: z.string().max(2048).optional(), data: stateData });

/** The query of the start: the landing path after the sign-in, and the app payload. */
export const startQuery = z.object({ next: z.string().max(2048).optional(), data: stateData });

/** The query of a GET callback. Every field is optional; the engine rules on what is missing. */
export const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/** The nonce request of the ID-token route (plan 12i Task 10): an empty object. */
export const idTokenNonceBody = z.strictObject({});

/**
 * The ID-token sign-in (plan 12i Task 10). A Google ID token is about 1 KB,
 * and 8192 characters is the cap of Apple's `id_token` form field above.
 * `name` is the name that Apple's native sheet gives the app; the engine
 * bounds it as a profile name.
 */
export const idTokenBody = z.strictObject({
  idToken: z.string().min(1).max(8192),
  nonce: z.string().max(128).optional(),
  name: z.string().max(256).optional(),
  next: z.string().max(2048).optional(),
  // A native app's trust token (plan 12c); a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});

/** The contract of `routes/social.ts` (plan 11g). */
export const SOCIAL_CONTRACT = {
  "GET /social/:provider/start": {
    query: { schema: startQuery, parsedBy: "hand" },
    answer: { kind: "redirect", param: "auth_error" },
  },
  "POST /social/:provider/link": {
    body: { schema: linkBody, media: ["json", "form"], parsedBy: "zod" },
    // JSON: the client navigates to `url`. A form: a 303 to the provider, or a 302 with the error.
    answer: { kind: "json", schema: z.strictObject({ url: z.string() }) },
    alt: { kind: "redirect", param: "auth_error", status: 303 },
  },
  "GET /social/:provider/callback": {
    query: { schema: callbackQuery, parsedBy: "hand" },
    answer: { kind: "redirect", param: "auth_error" },
  },
  "POST /social/apple/callback": {
    body: { schema: callbackBody, media: ["json", "form"], parsedBy: "zod" },
    answer: { kind: "redirect", param: "auth_error" },
  },
  "POST /social/:provider/id-token/nonce": {
    body: { schema: idTokenNonceBody, media: ["json"], parsedBy: "zod" },
    answer: {
      kind: "json",
      schema: z.strictObject({ nonce: z.string(), expiresAt: z.iso.datetime() }),
    },
  },
  "POST /social/:provider/id-token": {
    body: { schema: idTokenBody, media: ["json"], parsedBy: "zod" },
    // The session with `via`, or the challenge of a user with the second factor on (plan 12c).
    answer: { kind: "json", schema: z.union([SignInAnswer, TwoFactorChallenge]) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
