import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

/**
 * The contract of `http/health.ts` (plan 12h Task 8, spec 31 item 12). The
 * 503 of `/ready` is an error answer: `{ error: "not_ready", reason }`, as
 * the Error schema of the OpenAPI document writes it.
 */
export const HEALTH_CONTRACT = {
  "GET /health": {
    answer: { kind: "json", schema: z.strictObject({ status: z.literal("ok") }) },
  },
  "GET /ready": {
    answer: { kind: "json", schema: z.strictObject({ status: z.literal("ready") }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
