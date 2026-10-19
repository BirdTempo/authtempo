import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

/** The contract of `routes/openapi.ts` (plan 11g). */
export const OPENAPI_CONTRACT = {
  "GET /openapi.json": { answer: { kind: "metadata", standard: "openapi" } },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
