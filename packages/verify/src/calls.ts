import type { ClientCall } from "@authtempo/client";

/**
 * Every route that the verifier calls (plan 11d). `ClientCall` types each
 * path as a `RoutePath` of its method, so a path that core does not serve
 * fails the compile. The drift test of `@authtempo/sdk-conformance` holds the
 * table to `ROUTES`.
 */
export const VERIFY_CALLS = [
  { operation: "verify.jwks", method: "GET", path: "/jwks" },
  { operation: "verify.live", method: "POST", path: "/token/live" },
  { operation: "verify.apiToken", method: "GET", path: "/tokens/current" },
  { operation: "verify.session", method: "GET", path: "/session" },
] as const satisfies readonly ClientCall[];

export type VerifyOperation = (typeof VERIFY_CALLS)[number]["operation"];
