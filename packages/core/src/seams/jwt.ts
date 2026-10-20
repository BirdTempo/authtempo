import { createRemoteJWKSet, customFetch, importPKCS8, jwtVerify, SignJWT } from "jose";
import { PROVIDER_TIMEOUT_MS } from "../social/provider.js";

export interface VerifyIdTokenInput {
  token: string;
  jwksUrl: string;
  issuer: string | string[];
  audience: string;
  /** The engine clock, so a test can move time and a token can expire. */
  now: Date;
}

export interface SignES256Input {
  /** PKCS#8 PEM, the format Apple's developer portal downloads. */
  privateKeyPem: string;
  keyId: string;
  payload: Record<string, unknown>;
}

/**
 * The one place that imports jose. The engine verifies ID tokens and signs
 * the Apple client secret through this interface, so a test injects a fake
 * and a replacement library plugs into the same two calls.
 */
export interface JwtSeam {
  /** Verified claims. Throws on any failure: signature, issuer, audience, expiry. */
  verifyIdToken(input: VerifyIdTokenInput): Promise<Record<string, unknown>>;
  /** A compact JWS with `alg: ES256` and `kid`. The payload goes in as given. */
  signES256(input: SignES256Input): Promise<string>;
}

/**
 * The most remote key sets that one seam keeps. SSO connections add one JWKS
 * URL each, and a tenant can add many (plan 12d). At the limit the oldest set goes.
 */
export const JWKS_SETS_MAX = 500;

/** ID tokens from Google and Apple are RS256. ES256 is allowed for a provider that moves. */
const ID_TOKEN_ALGS = ["RS256", "ES256"];

export function createJoseJwtSeam(fetchFn: typeof fetch): JwtSeam {
  // One remote set per JWKS URL. jose caches the keys and refetches on an
  // unknown kid, with its own cooldown, so a key rotation needs no restart.
  const sets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  const jwks = (url: string) => {
    let set = sets.get(url);
    if (!set) {
      // Core owns the deadline of the JWKS read, as of every provider call
      // (plan 12b). Without it, jose stops the read after its own 5 s default.
      set = createRemoteJWKSet(new URL(url), {
        [customFetch]: fetchFn,
        timeoutDuration: PROVIDER_TIMEOUT_MS,
      });
      // A Map keeps insert order, so its first key is the oldest set.
      const oldest = sets.size >= JWKS_SETS_MAX ? sets.keys().next().value : undefined;
      if (oldest !== undefined) sets.delete(oldest);
      sets.set(url, set);
    }
    return set;
  };
  return {
    async verifyIdToken(input) {
      const { payload } = await jwtVerify(input.token, jwks(input.jwksUrl), {
        issuer: input.issuer,
        audience: input.audience,
        algorithms: ID_TOKEN_ALGS,
        currentDate: input.now,
      });
      return payload as Record<string, unknown>;
    },
    async signES256(input) {
      const key = await importPKCS8(input.privateKeyPem, "ES256");
      return new SignJWT(input.payload)
        .setProtectedHeader({ alg: "ES256", kid: input.keyId })
        .sign(key);
    },
  };
}
