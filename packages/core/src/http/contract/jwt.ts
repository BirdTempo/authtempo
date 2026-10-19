import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

/** The contract of `routes/jwt.ts` (plan 11g). */
export const JWT_CONTRACT = {
  "GET /jwks": { answer: { kind: "metadata", standard: "jwks" } },
  "GET /token": { answer: { kind: "json", schema: z.strictObject({ token: z.string() }) } },
  // Whether the session of the bearer JWT still exists. No body: the token is the input.
  "POST /token/live": {
    answer: { kind: "json", schema: z.strictObject({ live: z.boolean() }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
