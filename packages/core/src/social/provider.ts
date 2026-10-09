import type { JwtSeam } from "../seams/jwt.js";

export type SocialProviderName = "google" | "apple";

export interface SocialProfile {
  subject: string;
  /** Raw address from the provider; the engine normalizes it. Null when absent. */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
}

export interface CallbackExtra {
  /** Apple's `user` form field, a JSON string, present on the first sign-in only. */
  user?: string | undefined;
}

export interface ProviderContext {
  jwt: JwtSeam;
  now: Date;
}

/**
 * One provider is its endpoints, its client secret rule, and its claim
 * mapping. The engine owns the flow; a provider never redirects or stores.
 */
export interface Provider {
  name: SocialProviderName;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** Every issuer value the provider puts in `iss`. */
  issuer: string[];
  clientId: string;
  scope: string;
  /** Extra authorize parameters, for example Apple's `response_mode`. */
  authorizeParams: Record<string, string>;
  callbackMethod: "GET" | "POST";
  clientSecret(ctx: ProviderContext): Promise<string>;
  profile(claims: Record<string, unknown>, extra: CallbackExtra): SocialProfile;
}

/**
 * A query string with `%20` for a space. `URLSearchParams` writes `+`, and
 * Apple rejects `+` inside `scope` (field reports, checked 2026-10-09).
 */
export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const v = claims[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
