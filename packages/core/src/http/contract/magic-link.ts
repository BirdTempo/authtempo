import { z } from "zod";
import { MAGIC_LINK_TOKEN_RE } from "../../engine/magic-link.js";
import type { RouteKey } from "../route-list.js";
import { SentAnswer, SessionAnswer, TwoFactorChallenge } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const requestBody = z.object({
  email: z.string().max(320),
  next: z.string().max(2048).optional(),
});

export const verifyBody = z.object({
  token: z.string().max(64),
  // Plan 12c: a native app's trust token; a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});

/** The query of the link that the mail carries. The route holds the token to the engine's form. */
export const verifyQuery = z.object({ token: z.string().regex(MAGIC_LINK_TOKEN_RE) });

/** The contract of `routes/magic-link.ts` (plan 11g). */
export const MAGIC_LINK_CONTRACT = {
  "POST /magic-link/request": {
    body: { schema: requestBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "GET /magic-link/verify": {
    query: { schema: verifyQuery, parsedBy: "hand" },
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /magic-link/verify": {
    body: { schema: verifyBody, media: ["json", "form"], parsedBy: "zod" },
    answer: { kind: "json", schema: z.union([SessionAnswer, TwoFactorChallenge]) },
    alt: { kind: "redirect", param: "auth_error" },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
