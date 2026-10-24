import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import {
  constantTimeEqual,
  fromBase64Url,
  randomBase64Url,
  sha256Hex,
  toBase64Url,
} from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { IdTokenRoute, OidcProvider, SocialProfile } from "../social/provider.js";
import { StorageError } from "../storage/port.js";
import { type AnonymousCaller, upgradeSteps } from "./anonymous.js";
import type { SignInChallenge } from "./second-factor.js";
import { boundProfile, type ProfileSignedIn, signInByProfile } from "./social.js";

/**
 * The ID-token route (plan 12i Task 10, spec 32 item 10). Google One Tap and
 * Apple's native sheet give the app an ID token in place of a code. The app
 * first asks core for a nonce, passes it to the provider, and posts the
 * token with the nonce. Core spends the nonce once, verifies the token
 * against the provider's key set, its issuer, and the configured client
 * ids, and writes a row for the token, so a token signs in once on every
 * isolate. The sign-in then runs the account rules of spec 8.3, the gate
 * of 12c, and the anonymous upgrade of Task 7, as the social callback does.
 */

/** The providers that serve the route. Facebook Limited Login and others are not in 12i (spec 32 item 17). */
export const ID_TOKEN_PROVIDERS: readonly string[] = Object.freeze(["google", "apple"]);
/** A nonce lives 5 minutes: one sheet or one prompt, with no time to keep it for later. */
export const ID_TOKEN_NONCE_TTL_MS = 5 * 60_000;
/** Per IP, per 15 minutes: the nonce, and the sign-in. */
export const ID_TOKEN_NONCE_LIMIT = { seconds: 15 * 60, max: 60 };
export const ID_TOKEN_SIGN_IN_LIMIT = { seconds: 15 * 60, max: 30 };
/** The clock skew that an `iat` may have into the future. */
export const ID_TOKEN_IAT_SKEW_SECONDS = 60;
/**
 * The longest life of a token, `exp` minus `iat`. Google's tokens live one
 * hour. The used-token row lives until `exp`, so this bounds its life too.
 */
export const ID_TOKEN_LIFE_MAX_SECONDS = 86_400;
/** A nonce of core: 32 random bytes as base64url. */
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface IdTokenNonceInput {
  provider: string;
  ip: string | null;
}

export interface IdTokenNonce {
  nonce: string;
  expiresAt: Date;
}

export interface IdTokenSignIn {
  provider: string;
  idToken: string;
  /** The raw nonce of `idTokenNonce`. Needed while `requireNonce` is on. */
  nonce?: string | undefined;
  /** Apple's native sheet gives the name to the app, not in the token. It fills a new user only. */
  name?: string | undefined;
  next?: string | undefined;
  /** The clear `td_` token of a trusted device (plan 12c). */
  trustDevice?: string | undefined;
  ip: string | null;
  userAgent: string | null;
  /** The live anonymous session of the request (plan 12i Task 7). The request is the proof, so it links. */
  anonymous?: AnonymousCaller | null | undefined;
}

/** The provider of the route with its ID-token settings, or null: the route serves no other provider. */
function routeProvider(
  config: ResolvedConfig,
  name: string,
): (OidcProvider & { idToken: IdTokenRoute }) | null {
  if (!config.social.idToken || !ID_TOKEN_PROVIDERS.includes(name)) return null;
  const p = config.social.providers.find((x) => x.name === name);
  return p?.kind === "oidc" && p.idToken ? (p as OidcProvider & { idToken: IdTokenRoute }) : null;
}

/** Writes a nonce row and answers the clear nonce. Only its SHA-256 hex is stored. */
export async function idTokenNonce(
  config: ResolvedConfig,
  input: IdTokenNonceInput,
): Promise<Result<IdTokenNonce>> {
  const provider = routeProvider(config, input.provider);
  if (!provider) return fail("not_found");
  if (!(await limit(config, "id-token-nonce:ip", ipKey(input.ip), ID_TOKEN_NONCE_LIMIT)))
    return fail("rate_limited");
  const now = config.clock.now();
  const nonce = randomBase64Url(32);
  const expiresAt = new Date(now.getTime() + ID_TOKEN_NONCE_TTL_MS);
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "id-token-nonce",
    identifier: provider.name,
    valueHash: await sha256Hex(nonce),
    expiresAt,
    consumedAt: null,
    data: null,
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  return ok({ nonce, expiresAt });
}

/**
 * The key of a used token: the SHA-256 hex of its payload bytes in the
 * canonical base64url. jose takes a segment whose last character has other
 * spare bits, so one token has more than one text form. A hash of the text
 * would let such a copy sign in again. The payload is signed, so two forms
 * of one token give one key. An ES256 signature has two valid forms too, so
 * the key leaves the signature out.
 */
async function usedKey(provider: string, idToken: string): Promise<string | null> {
  const payload = idToken.split(".")[1];
  if (payload === undefined) return null;
  try {
    return await sha256Hex(`id-token-used:${provider}:${toBase64Url(fromBase64Url(payload))}`);
  } catch {
    return null;
  }
}

/** The nonce claim matches the raw nonce in the provider's form. */
async function nonceMatches(form: IdTokenRoute["nonceForm"], claim: unknown, nonce: string) {
  if (typeof claim !== "string") return false;
  if (constantTimeEqual(claim, nonce)) return true;
  return form === "raw-or-sha256" && constantTimeEqual(claim, await sha256Hex(nonce));
}

/**
 * The claims that jose does not check: one `aud` string, a numeric `iat`
 * that is not in the future past the skew, and a numeric `exp` at most one
 * day after `iat`. jose checks the signature, `iss`, the `aud` list, the
 * alg, and that `exp` is not past.
 */
function claimsInRange(claims: Record<string, unknown>, now: Date): boolean {
  const { aud, iat, exp } = claims;
  if (typeof aud !== "string") return false;
  if (typeof iat !== "number" || typeof exp !== "number") return false;
  const nowSeconds = now.getTime() / 1000;
  if (iat > nowSeconds + ID_TOKEN_IAT_SKEW_SECONDS) return false;
  return exp > iat && exp - iat <= ID_TOKEN_LIFE_MAX_SECONDS;
}

/**
 * The sign-in by an ID token. Every failure of the token answers
 * `invalid_token` with one event that names the provider, never the token.
 * The order: the limit, the nonce spend, the verify, the claims, the nonce
 * compare, and the used-token row. A spent nonce or a written row is never
 * undone: a failure after them sends the app back for a new token.
 */
export async function signInWithIdToken(
  config: ResolvedConfig,
  input: IdTokenSignIn,
): Promise<Result<ProfileSignedIn | SignInChallenge>> {
  const provider = routeProvider(config, input.provider);
  const settings = config.social.idToken;
  if (!provider || !settings) return fail("not_found");
  if (!(await limit(config, "id-token:ip", ipKey(input.ip), ID_TOKEN_SIGN_IN_LIMIT)))
    return fail("rate_limited");
  const now = config.clock.now();
  const nonce = input.nonce;
  if (nonce === undefined && settings.requireNonce) return fail("invalid_token");
  if (nonce !== undefined) {
    if (!NONCE_RE.test(nonce)) return fail("invalid_token");
    // One conditional update spends the nonce: a second use, an expired
    // nonce, and a nonce of the other provider match no row.
    const spent = await config.storage.update(
      "verification",
      [
        { field: "valueHash", op: "eq", value: await sha256Hex(nonce) },
        { field: "purpose", op: "eq", value: "id-token-nonce" },
        { field: "identifier", op: "eq", value: provider.name },
        { field: "consumedAt", op: "eq", value: null },
        { field: "expiresAt", op: "gt", value: now },
      ],
      { consumedAt: now, updatedAt: now },
    );
    if (spent !== 1) return fail("invalid_token");
  }
  let claims: Record<string, unknown>;
  try {
    claims = await config.jwt.verifyIdToken({
      token: input.idToken,
      jwksUrl: provider.jwksUrl,
      issuer: provider.issuer,
      audience: [provider.clientId, ...provider.idToken.audiences],
      now,
    });
  } catch (e) {
    config.observe.emit({
      name: "social.id_token_rejected",
      provider: provider.name,
      errorClass: e,
    });
    return fail("invalid_token");
  }
  if (!claimsInRange(claims, now) || (provider.checkClaims && !provider.checkClaims(claims))) {
    config.observe.emit({ name: "social.claims_refused", provider: provider.name });
    return fail("invalid_token");
  }
  if (
    nonce !== undefined &&
    !(await nonceMatches(provider.idToken.nonceForm, claims.nonce, nonce))
  ) {
    config.observe.emit({ name: "social.nonce_mismatch", provider: provider.name });
    return fail("invalid_token");
  }
  const key = await usedKey(provider.name, input.idToken);
  if (key === null) return fail("invalid_token");
  // The unique key on valueHash refuses a second use on every isolate and adapter.
  try {
    await config.storage.create("verification", {
      id: newId(now),
      purpose: "id-token-used",
      identifier: provider.name,
      valueHash: key,
      // claimsInRange checked that exp is a number.
      expiresAt: new Date((claims.exp as number) * 1000),
      consumedAt: null,
      data: null,
      createdAt: now,
      updatedAt: now,
      secretVersion: config.keyring.current,
    });
  } catch (err) {
    if (err instanceof StorageError && err.code === "unique_violation") {
      config.observe.emit({ name: "social.id_token_replayed", provider: provider.name });
      return fail("invalid_token");
    }
    throw err;
  }
  const mapped = provider.profile(claims, {});
  const named: SocialProfile =
    provider.name === "apple" && input.name !== undefined
      ? { ...mapped, name: input.name, nameOnCreate: true }
      : mapped;
  const bounded = boundProfile(config.observe, named, provider.name);
  if (!bounded) return fail("oauth_failed");
  return signInByProfile(config, {
    provider: provider.name,
    profile: bounded,
    addressless: false,
    next: safeNext(input.next),
    ip: input.ip,
    userAgent: input.userAgent,
    trustDevice: input.trustDevice,
    // The request that carries the token carries the anonymous session too: a bound pathway.
    upgrade: upgradeSteps(config, input.anonymous ?? null, null, "bound"),
    now,
  });
}
