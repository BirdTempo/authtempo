import type { ClientCall } from "@authtempo/client";

/**
 * The route that the handoff builds a URL for (plan 11d): the system browser
 * opens it. The redeem is the client's `handoff.redeem`. The drift test of
 * plan 11d Task 13 (the SDK conformance package) holds the table to `ROUTES`.
 */
export const HANDOFF_CALLS = [
  { operation: "handoff.start", method: "GET", path: "/handoff/start" },
] as const satisfies readonly ClientCall[];
