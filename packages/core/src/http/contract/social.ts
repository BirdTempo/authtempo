import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

/** Apple posts these as a form. Every field is optional; the engine rules on what is missing. */
export const callbackBody = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(128).optional(),
  error: z.string().max(256).optional(),
  user: z.string().max(4096).optional(),
  id_token: z.string().max(8192).optional(),
});

// Not strict: a form may carry the name of its button.
export const linkBody = z.object({ next: z.string().max(2048).optional() });

/** The query of the start: the landing path after the sign-in. */
export const startQuery = z.object({ next: z.string().max(2048).optional() });

/** The query of a GET callback. Every field is optional; the engine rules on what is missing. */
export const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
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
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
