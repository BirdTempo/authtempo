import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SessionAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

// A core session id has 26 characters (newId). The cap of 64 leaves a margin and bounds the read.
export const sessionIdBody = z.strictObject({ sessionId: z.string().min(1).max(64) });

/**
 * One session of the browser (plan 12i Task 11). It holds no token: the
 * tokens stay in the HttpOnly cookies.
 */
export const BrowserSession = z.strictObject({
  sessionId: z.string(),
  active: z.boolean(),
  user: z.strictObject({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    username: z.string().nullable(),
    image: z.string().nullable(),
  }),
});

/** The contract of `routes/multi-session.ts` (plan 12i Task 11). */
export const MULTI_SESSION_CONTRACT = {
  "GET /multi-session": {
    answer: { kind: "json", schema: z.strictObject({ sessions: z.array(BrowserSession) }) },
  },
  "POST /multi-session/switch": {
    body: { schema: sessionIdBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SessionAnswer },
  },
  "POST /multi-session/sign-out": {
    body: { schema: sessionIdBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
