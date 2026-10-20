import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SessionAnswer, SessionReadAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

// A core session id has 26 characters (newId). The cap of 64 leaves a margin and bounds the read.
export const revokeBody = z.strictObject({ id: z.string().min(1).max(64) });

/** One live session of the caller, as `listSessions` answers it (plan 12a). It holds no token. */
export const SessionSummary = z.strictObject({
  id: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  freshAt: z.iso.datetime().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  activeOrganizationId: z.string().nullable(),
  current: z.boolean(),
  /** True for a session that a platform operator opened (plan 12f). It names no operator. */
  impersonation: z.boolean(),
});

/** The contract of `routes/sessions.ts` (plan 11g). */
export const SESSIONS_CONTRACT = {
  "GET /session": { answer: { kind: "json", schema: SessionReadAnswer } },
  "POST /session/refresh": { answer: { kind: "json", schema: SessionAnswer } },
  "POST /sign-out": { answer: { kind: "json", schema: OkAnswer } },
  "GET /sessions": {
    answer: { kind: "json", schema: z.strictObject({ sessions: z.array(SessionSummary) }) },
  },
  "POST /sessions/revoke": {
    body: { schema: revokeBody, media: ["json"], parsedBy: "zod" },
    // `current` tells a bearer client that its own token ended (plan 12a).
    answer: { kind: "json", schema: z.strictObject({ ok: z.literal(true), current: z.boolean() }) },
  },
  "POST /sessions/revoke-others": {
    answer: { kind: "json", schema: z.strictObject({ ended: z.number().int().min(0) }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
