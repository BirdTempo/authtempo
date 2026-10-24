import { createRemoteJWKSet, customFetch, importPKCS8, jwtVerify, SignJWT } from "jose";
import { PROVIDER_TIMEOUT_MS } from "../social/provider.js";

export interface VerifyIdTokenInput {
  token: string;
  jwksUrl: string;
  issuer: string | string[];
  /**
   * The client ids that the token may name in `aud`. A list holds the web
   * client id and the ids of the app's native clients (plan 12i Task 10).
   */
  audience: string | string[];
  /** The engine clock, so a test can move time and a token can expire. */
  now: Date;
  /**
   * The fetch of the JWKS read of this call, in place of the fetch of the
   * seam. An SSO connection passes `sso.fetch` with a byte cap (plan 12d).
   * A seam that an app writes must use it, else that cap does not hold.
   */
  fetch?: typeof fetch;
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
 * URL each, and a tenant can add many (plan 12d). At the limit the set that
 * was used the longest time ago goes. So the sets of many SSO connections
 * cannot push out the set of Google or Apple while sign-ins use it.
 */
export const JWKS_SETS_MAX = 500;

/** ID tokens from Google and Apple are RS256. ES256 is allowed for a provider that moves. */
const ID_TOKEN_ALGS = ["RS256", "ES256"];

export function createJoseJwtSeam(fetchFn: typeof fetch): JwtSeam {
  // One remote set per JWKS URL and fetch. jose caches the keys and refetches
  // on an unknown kid, with its own cooldown, so a key rotation needs no restart.
  const sets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  // A set keeps the fetch that made it, so the key holds a number per fetch.
  // Then the set of a social provider never serves an SSO read of the same URL.
  const fetchIds = new WeakMap<typeof fetch, number>();
  let nextFetchId = 0;
  const keyOf = (url: string, f: typeof fetch) => {
    let id = fetchIds.get(f);
    if (id === undefined) {
      id = nextFetchId++;
      fetchIds.set(f, id);
    }
    return `${id} ${url}`;
  };
  const jwks = (url: string, f: typeof fetch) => {
    const key = keyOf(url, f);
    let set = sets.get(key);
    if (set) {
      // A use moves the set to the end, so the first key is the least recently used set.
      sets.delete(key);
      sets.set(key, set);
    } else {
      // Core owns the deadline of the JWKS read, as of every provider call
      // (plan 12b). Without it, jose stops the read after its own 5 s default.
      set = createRemoteJWKSet(new URL(url), {
        [customFetch]: f,
        timeoutDuration: PROVIDER_TIMEOUT_MS,
      });
      // A Map keeps insert order, so its first key is the set used the longest time ago.
      const oldest = sets.size >= JWKS_SETS_MAX ? sets.keys().next().value : undefined;
      if (oldest !== undefined) sets.delete(oldest);
      sets.set(key, set);
    }
    return set;
  };
  return {
    async verifyIdToken(input) {
      const { payload } = await jwtVerify(
        input.token,
        jwks(input.jwksUrl, input.fetch ?? fetchFn),
        {
          issuer: input.issuer,
          audience: input.audience,
          algorithms: ID_TOKEN_ALGS,
          currentDate: input.now,
        },
      );
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
