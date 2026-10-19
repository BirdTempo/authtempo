import { z } from "zod";
import { CHALLENGE_RE, ID_RE } from "../../engine/handoff.js";
import type { RouteKey } from "../route-list.js";
import { SignedInAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const continueBody = z.object({ h: z.string().max(64) });
export const redeemBody = z.object({
  code: z.string().max(64),
  verifier: z.string().min(43).max(128),
});

/** The query of the start: the app's PKCE challenge and its redirect. The engine holds both to its rules. */
export const startQuery = z.object({
  challenge: z.string().regex(CHALLENGE_RE),
  redirect: z.string().min(1),
});

/** The query of the continue page: the handoff id that the start answered. The engine holds it to its form. */
export const continueQuery = z.object({ h: z.string().regex(ID_RE) });

/** The contract of `routes/handoff.ts` (plan 11g). */
export const HANDOFF_CONTRACT = {
  "GET /handoff/start": {
    query: { schema: startQuery, parsedBy: "hand" },
    // The sign-in page; a browser with a session goes to the continue page.
    answer: { kind: "html" },
    alt: { kind: "redirect" },
  },
  "GET /handoff/continue": {
    query: { schema: continueQuery, parsedBy: "hand" },
    // The sign-in page with no session, the confirm page with one.
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /handoff/continue": {
    body: { schema: continueBody, media: ["json", "form"], parsedBy: "zod" },
    // The app's redirect with the code, or the app's error page; the sign-in page with no session.
    answer: { kind: "redirect", param: "auth_error" },
    alt: { kind: "html" },
  },
  "POST /handoff/redeem": {
    body: { schema: redeemBody, media: ["json"], parsedBy: "zod" },
    // A bearer answer: the app keeps the token. No cookie.
    answer: { kind: "json", schema: SignedInAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
