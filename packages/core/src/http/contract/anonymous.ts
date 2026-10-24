import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SignedInAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

export const signInBody = z.strictObject({});
export const deleteBody = z.strictObject({});

/** The contract of `routes/anonymous.ts` (plan 12i Task 6). */
export const ANONYMOUS_CONTRACT = {
  "POST /anonymous/sign-in": {
    body: { schema: signInBody, media: ["json"], parsedBy: "zod" },
    // A new anonymous session, or the caller's live anonymous session again. No gate (Review Focus 1).
    answer: { kind: "json", schema: SignedInAnswer },
  },
  "POST /anonymous/delete": {
    body: { schema: deleteBody, media: ["json"], parsedBy: "zod" },
    // The session is gone: the answer clears the cookie, as the sign-out does.
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
