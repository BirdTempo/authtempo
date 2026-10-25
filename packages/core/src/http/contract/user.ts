import { z } from "zod";
import { DELETE_TOKEN_RE } from "../../engine/account-delete.js";
import { EMAIL_CHANGE_TOKEN_RE } from "../../engine/email-change.js";
import { USER_INVITE_TOKEN_RE } from "../../engine/user-invite.js";
import type { RouteKey } from "../route-list.js";
import {
  OkAnswer,
  SentAnswer,
  SessionSignInAnswer,
  TwoFactorChallenge,
  UserJson,
} from "./shapes.js";
import type { RouteContract } from "./types.js";

export const updateBody = z.strictObject({
  // The engine applies the name and image rules; these caps bound the body.
  name: z.string().max(400).nullable().optional(),
  image: z.string().max(4096).nullable().optional(),
});
export const changeBody = z.strictObject({
  // The engine normalizes the address; the cap bounds the body.
  newEmail: z.string().max(320),
  method: z.enum(["link", "code"]).optional(),
  next: z.string().max(2048).optional(),
});
// Not strict: a form may carry the name of its button.
export const confirmBody = z.object({ token: z.string().max(64) });
/** The confirm of an invitation link (plan 12f2 Task 3). Not strict, as `confirmBody`. */
export const inviteConfirmBody = z.object({
  token: z.string().max(64),
  // A native app's trust token (plan 12c); a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});
/** The query of the invitation link. The route holds the token to the engine's form. */
export const inviteConfirmQuery = z.object({ token: z.string().regex(USER_INVITE_TOKEN_RE) });
export const verifyBody = z.strictObject({ code: z.string().min(1).max(16) });
// No field: the fresh session is the proof. Strict, so a client that sends a password learns that core reads none.
export const deleteBody = z.strictObject({});

/** The query of the mailed address-change link. The route holds the token to the engine's form. */
export const confirmQuery = z.object({ token: z.string().regex(EMAIL_CHANGE_TOKEN_RE) });

/** The query of the mailed delete link. The route holds the token to the engine's form. */
export const deleteConfirmQuery = z.object({ token: z.string().regex(DELETE_TOKEN_RE) });

const userAnswer = z.strictObject({ user: UserJson });

/** The contract of `routes/user.ts` (plan 11g). */
export const USER_CONTRACT = {
  "POST /user/update": {
    body: { schema: updateBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: userAnswer },
  },
  "POST /user/change-email": {
    body: { schema: changeBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "GET /user/change-email/confirm": {
    query: { schema: confirmQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /user/change-email/confirm": {
    body: { schema: confirmBody, media: ["json", "form"], parsedBy: "zod" },
    // JSON: the user with the new address. A form: the landing path, or the app's error page.
    answer: { kind: "json", schema: userAnswer },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /user/change-email/verify": {
    body: { schema: verifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: userAnswer },
  },
  "POST /user/delete": {
    body: { schema: deleteBody, media: ["json"], parsedBy: "zod" },
    // `{ ok: true }` ends the account; `{ sent: true }` mailed a link (`account.deleteConfirm`).
    answer: { kind: "json", schema: z.union([OkAnswer, SentAnswer]) },
  },
  "GET /user/delete/confirm": {
    query: { schema: deleteConfirmQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /user/delete/confirm": {
    body: { schema: confirmBody, media: ["json", "form"], parsedBy: "zod" },
    // JSON: `{ ok: true }` with the cleared cookie. A form: the app's root, or the app's error page.
    answer: { kind: "json", schema: OkAnswer },
    alt: { kind: "redirect", param: "auth_error" },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;

/** The contract of `routes/user-invite.ts` (plan 12f2 Task 3). */
export const USER_INVITE_CONTRACT = {
  "GET /user/invite/confirm": {
    query: { schema: inviteConfirmQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /user/invite/confirm": {
    body: { schema: inviteConfirmBody, media: ["json", "form"], parsedBy: "zod" },
    answer: { kind: "json", schema: z.union([SessionSignInAnswer, TwoFactorChallenge]) },
    alt: { kind: "redirect", param: "auth_error" },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
