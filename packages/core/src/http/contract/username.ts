import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

// The engine applies NFKC and the length bounds of `username`; this cap only bounds the input.
const typedName = z.string().max(256);

/** The query of the availability check. */
export const availableQuery = z.strictObject({ username: typedName });
export const setBody = z.strictObject({ username: typedName });

/** The contract of `routes/username.ts` (plan 12i Task 2). */
export const USERNAME_CONTRACT = {
  "GET /username/available": {
    query: { schema: availableQuery, parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ available: z.boolean() }) },
  },
  "POST /user/username": {
    body: { schema: setBody, media: ["json"], parsedBy: "zod" },
    // The stored form and the typed case.
    answer: {
      kind: "json",
      schema: z.strictObject({ username: z.string(), displayUsername: z.string() }),
    },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
