import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import type { RouteContract } from "./types.js";

/** The contract of `routes/operator.ts` (plan 11g). The answer names the new signing key. */
export const OPERATOR_CONTRACT = {
  "POST /operator/keys/rotate": {
    answer: { kind: "json", schema: z.strictObject({ kid: z.string() }) },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
