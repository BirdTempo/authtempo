import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import {
  constantTimeEqual,
  randomBase64Url,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import {
  buildQuery,
  type ConfiguredProvider,
  isHttpsUrl,
  type OAuth2Provider,
  type OidcProvider,
  PROVIDER_TIMEOUT_MS,
  type Provider,
  type SocialProfile,
  stringClaim,
} from "../social/provider.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { createSession } from "./sessions.js";
import {
  ClaimRacedError,
  claimEmail,
  ensureEmailIdentity,
  normalizeEmail,
  undoSessionIfIdentityGone,
  userStillUnverified,
  validUserName,
} from "./users.js";

export const OAUTH_STATE_PREFIX = "os_";
const STATE_RE = /^os_[A-Za-z0-9_-]{43}$/;
const STATE_TTL_MS = 10 * 60_000;
const START_LIMIT = { seconds: 15 * 60, max: 30 };

export interface SocialStart {
  provider: string;
  next?: string | undefined;
  ip: string | null;
}

export interface SocialStarted {
  /** The provider's authorize URL with every parameter. */
  location: string;
  /** The clear binding value for the cookie. Its hash is in the row. */
  bindToken: string;
}

export interface SocialComplete {
  provider: string;
  state: string | null;
  code: string | null;
  /** The provider's `error` parameter, for example `access_denied`. */
  error: string | null;
  /** Apple's `user` form field on the first sign-in. */
  user?: string | null | undefined;
  /** The binding cookie value, or null when the cookie is missing. */
  bindToken: string | null;
  ip: string | null;
  userAgent: string | null;
}

interface StateData {
  verifier: string;
  nonceHash: string;
  bindHash: string;
  next: string;
}

function findProvider(config: ResolvedConfig, name: string): ConfiguredProvider | undefined {
  return config.social.providers.find((p) => p.name === name);
}

/** The provider with its endpoints. A discovery entry reads them on first use (plan 9c). */
async function resolveProvider(
  config: ResolvedConfig,
  entry: ConfiguredProvider,
): Promise<Provider | null> {
  return entry.kind === "oidc-discovery" ? entry.resolve(config.social.fetch) : entry;
}

function callbackUrl(config: ResolvedConfig, provider: { name: string }): string {
  return `${config.baseURL}${config.basePath}/social/${provider.name}/callback`;
}

/**
 * Writes one verification row that holds everything the callback needs,
 * then builds the authorize URL. The row's hash fields let the callback
 * check the nonce and the binding cookie without storing their clear values.
 */
export async function startSocial(
  config: ResolvedConfig,
  input: SocialStart,
): Promise<Result<SocialStarted>> {
  const entry = findProvider(config, input.provider);
  if (!entry) return fail("not_found");
  if (!(await config.limiter.allow(`social-start:ip:${input.ip ?? "unknown"}`, START_LIMIT))) {
    return fail("rate_limited");
  }
  // After the limit, so the limit bounds the discovery reads.
  const provider = await resolveProvider(config, entry);
  if (!provider) return fail("oauth_failed");
  const now = config.clock.now();
  const state = randomToken(OAUTH_STATE_PREFIX);
  const verifier = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const bindToken = randomBase64Url(32);
  const data: StateData = {
    verifier,
    nonceHash: await sha256Hex(nonce),
    bindHash: await sha256Hex(bindToken),
    next: safeNext(input.next),
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "oauth-state",
    identifier: provider.name,
    valueHash: await sha256Hex(state),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
  });
  const query = buildQuery({
    client_id: provider.clientId,
    redirect_uri: callbackUrl(config, provider),
    response_type: "code",
    scope: provider.scope,
    state,
    // An oauth2 provider issues no ID token, so a nonce has nothing to bind (plan 9c).
    ...(provider.kind === "oidc" ? { nonce } : {}),
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
    ...provider.authorizeParams,
  });
  return ok({ location: `${provider.authorizeUrl}?${query}`, bindToken });
}

/**
 * Consumes the state row first, so a replayed callback fails before any
 * network call. Then binds the browser, exchanges the code, verifies the
 * ID token and its nonce, and links or creates the user.
 */
export async function completeSocial(
  config: ResolvedConfig,
  input: SocialComplete,
): Promise<Result<{ token: string; next: string; user: UserRow }>> {
  const entry = findProvider(config, input.provider);
  if (!entry) return fail("not_found");
  const state = input.state ?? "";
  if (!STATE_RE.test(state)) return fail("invalid_token");
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(state) },
    { field: "purpose", op: "eq", value: "oauth-state" },
  ]);
  if (!row) return fail("invalid_token");
  const consumed = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  if (consumed !== 1) {
    const expired = row.consumedAt === null && row.expiresAt.getTime() <= now.getTime();
    return fail(expired ? "token_expired" : "invalid_token");
  }
  // From here the state is spent. Every failure below sends the person back
  // to start again, which is the safe direction.
  if (row.identifier !== entry.name) return fail("invalid_token");
  const data = row.data as StateData | null;
  if (!data || typeof data.verifier !== "string") return fail("invalid_token");
  if (!input.bindToken || !constantTimeEqual(await sha256Hex(input.bindToken), data.bindHash)) {
    return fail("invalid_token");
  }
  if (input.error) return fail("oauth_denied");
  if (!input.code) return fail("oauth_failed");
  const provider = await resolveProvider(config, entry);
  if (!provider) return fail("oauth_failed");

  const token = await exchangeCode(config, provider, input.code, data.verifier, now);
  if (token === null) return fail("oauth_failed");
  const profile =
    provider.kind === "oidc"
      ? await idTokenProfile(config, provider, token, data.nonceHash, input.user ?? undefined, now)
      : await userinfoProfile(config, provider, token);
  const bounded = profile ? boundProfile(profile, provider.name) : null;
  if (!bounded) return fail("oauth_failed");

  // The session commits with the claim in one transaction, so a claimant's
  // in-flight callback cannot keep a session the claim deleted.
  const resolved = await resolveSocialUser(
    config.storage,
    provider.name,
    bounded,
    now,
    (tx, user) =>
      createSession(config, { userId: user.id, ip: input.ip, userAgent: input.userAgent }, tx),
  );
  if (!resolved.ok) return resolved;
  const { user, after } = resolved.value;
  return ok({ token: after.token, next: safeNext(data.next), user });
}

/**
 * The token that the provider's kind needs, or null on any failure: the ID
 * token of an `oidc` provider, the access token of an `oauth2` provider.
 * Logs the status or the error name only, never a token or the code.
 */
async function exchangeCode(
  config: ResolvedConfig,
  provider: Provider,
  code: string,
  verifier: string,
  now: Date,
): Promise<string | null> {
  let clientSecret: string;
  try {
    clientSecret = await provider.clientSecret({ jwt: config.jwt, now });
  } catch (e) {
    console.error(
      "tempo-auth: social client secret failed",
      provider.name,
      e instanceof Error ? e.name : typeof e,
    );
    return null;
  }
  let res: Response;
  try {
    res = await config.social.fetch(provider.tokenUrl, {
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: buildQuery({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(config, provider),
        client_id: provider.clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
  } catch (e) {
    console.error(
      "tempo-auth: social token request failed",
      provider.name,
      e instanceof Error ? e.name : typeof e,
    );
    return null;
  }
  if (!res.ok) {
    console.error("tempo-auth: social token endpoint answered", provider.name, res.status);
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const field = provider.kind === "oidc" ? "id_token" : "access_token";
  const token = (body as Record<string, unknown> | null)?.[field];
  if (typeof token === "string" && token.length > 0) return token;
  // GitHub answers a bad code with 200 and an `error` field. Log no value of the body.
  console.error("tempo-auth: social token answer has no token", provider.name);
  return null;
}

/** The profile from a verified ID token whose nonce matches the row, or null. */
async function idTokenProfile(
  config: ResolvedConfig,
  provider: OidcProvider,
  idToken: string,
  nonceHash: string,
  user: string | undefined,
  now: Date,
): Promise<SocialProfile | null> {
  let claims: Record<string, unknown>;
  try {
    claims = await config.jwt.verifyIdToken({
      token: idToken,
      jwksUrl: provider.jwksUrl,
      issuer: provider.issuer,
      audience: provider.clientId,
      now,
    });
  } catch (e) {
    console.error(
      "tempo-auth: social id token rejected",
      provider.name,
      e instanceof Error ? e.name : typeof e,
    );
    return null;
  }
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || !constantTimeEqual(await sha256Hex(nonce), nonceHash)) {
    console.error("tempo-auth: social nonce mismatch", provider.name);
    return null;
  }
  return provider.profile(claims, { user });
}

/**
 * The profile from an oauth2 provider's `userinfo`, or null on any failure
 * (plan 9c). One deadline covers the whole step, so a function that never
 * calls fetch stops too, and every fetch the function makes carries the same
 * signal. The access token is an argument only: it is never stored, and a
 * failure logs the error name, never its message, which may hold the token.
 */
async function userinfoProfile(
  config: ResolvedConfig,
  provider: OAuth2Provider,
  accessToken: string,
): Promise<SocialProfile | null> {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const timedFetch: typeof fetch = (input, init) => config.social.fetch(input, { ...init, signal });
  // Promise.race keeps a handler on this promise, so its late rejection is handled.
  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    const answer: unknown = await Promise.race([
      provider.userinfo(accessToken, timedFetch),
      deadline,
    ]);
    // The function is app code. Only a boolean true is a verified address, so
    // no provider widens the linking rule of spec 8.3. The fields are read
    // here, inside the try, so a getter that throws answers oauth_failed.
    const a = (typeof answer === "object" && answer !== null ? answer : {}) as Record<
      string,
      unknown
    >;
    return {
      subject: typeof a.subject === "string" ? a.subject : "",
      email: stringClaim(a, "email"),
      emailVerified: a.emailVerified === true,
      name: stringClaim(a, "name"),
      image: stringClaim(a, "image"),
    };
  } catch (e) {
    console.error("tempo-auth: social user info failed", provider.name, appErrorName(e));
    return null;
  }
}

/**
 * The one bound on a profile, for both provider kinds (plan 9c final review
 * I-2). A bad subject refuses the sign-in: the subject is an identity key, so
 * core never trims it. A bad name or image is dropped, not refused, so the
 * person can still sign in. The image must be an `https:` URL, so a
 * `javascript:` or `data:` value never reaches the user row.
 */
function boundProfile(profile: SocialProfile, providerName: string): SocialProfile | null {
  const subject = profile.subject;
  if (
    subject.length < 1 ||
    subject.length > SUBJECT_MAX ||
    hasControlChar(subject) ||
    subject.trim().length === 0
  ) {
    console.error("tempo-auth: social user info has a bad subject", providerName);
    return null;
  }
  const { name, image } = profile;
  return {
    ...profile,
    name: name !== null && validUserName(name) ? name : null,
    image:
      image !== null && image.length <= IMAGE_MAX && !hasControlChar(image) && isHttpsUrl(image)
        ? image
        : null,
  };
}

/** The identity row's subject. 255 covers every provider id we know and bounds the row. */
const SUBJECT_MAX = 255;
/** An image URL. LinkedIn's signed picture URLs pass 255, so the bound is wider than the subject's. */
const IMAGE_MAX = 2048;
const ERROR_CLASS_RE = /^[A-Za-z]+Error$/;

/**
 * The name of an error from app code, safe for a log line. The app sets the
 * name, so it is app data and can hold the access token. Only a plain class
 * name such as `TypeError` passes; anything else logs as `Error`.
 */
function appErrorName(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  return ERROR_CLASS_RE.test(e.name) ? e.name : "Error";
}

/**
 * Links the identity to a user by the spec's rules. One transaction per
 * attempt. A `unique_violation` is caught here, outside the transaction,
 * and the whole resolution runs once more against the winner's rows.
 * `after` runs inside the same transaction once the user is resolved, so
 * the sign-in's session commits with the claim. When an existing identity
 * row without a proof of the address authorizes the sign-in, a guard on
 * that row is the last statement. When this transaction creates an
 * unverified user, the guard is on the user row. A raced claim answers
 * `email_taken_unverified` in both cases.
 */
export function resolveSocialUser(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
): Promise<Result<UserRow>>;
export function resolveSocialUser<T extends AfterSession>(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
  after: (tx: StorageAdapter, user: UserRow) => Promise<T>,
): Promise<Result<{ user: UserRow; after: T }>>;
export async function resolveSocialUser<T extends AfterSession>(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
  after?: (tx: StorageAdapter, user: UserRow) => Promise<T>,
): Promise<Result<UserRow> | Result<{ user: UserRow; after: T }>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await storage.transaction(
        async (tx): Promise<Result<UserRow> | Result<{ user: UserRow; after: T }>> => {
          const linked = await linkInTransaction(tx, provider, profile, now);
          if (!linked.ok) return linked;
          const { user, trustedIdentityId, created } = linked.value;
          if (!after) return ok(user);
          const value = await after(tx, user);
          if (trustedIdentityId && created) {
            // On D1 a claim can find the user that this transaction created
            // before the commit. A throw would undo the user create, and the
            // undo deletes the user row by id. That row is the owner's now:
            // the owner's email identity and session would point to no user,
            // and the owner could not sign in again (final review I-1).
            // The guard is on the user row, not on the identity row: a claim
            // that ran before this transaction created its identity did not
            // delete that identity (re-review R-1). claimEmail flips the flag
            // in its first statement, so any claim since the user create
            // makes this match zero rows. Then delete the own session and the
            // own identity by id, and commit, so no undo runs. When it
            // matches one row it is the last statement, so no undo runs after
            // it, and a later claim deletes the identity and the session.
            // Checked 2026-10-10.
            if (!(await userStillUnverified(tx, user.id, now))) {
              await tx.delete("session", [{ field: "id", op: "eq", value: value.session.id }]);
              await tx.delete("identity", [{ field: "id", op: "eq", value: trustedIdentityId }]);
              return fail<never>("email_taken_unverified");
            }
          } else if (trustedIdentityId) {
            // A claim can land between this insert and the commit; on D1 and on Postgres read committed the delete in claimEmail may miss this row. The conditional update sees the claim's first statement and undoes the insert.
            await undoSessionIfIdentityGone(tx, trustedIdentityId, now);
          }
          return ok({ user, after: value });
        },
      );
    } catch (err) {
      // The claim won. The address is proved by its owner now.
      if (err instanceof ClaimRacedError) return fail<never>("email_taken_unverified");
      if (attempt === 0 && err instanceof StorageError && err.code === "unique_violation") continue;
      throw err;
    }
  }
}

/**
 * The resolved user, and the identity row that authorizes the sign-in when
 * no proof of the address does. A claim deletes that row.
 */
interface Linked {
  user: UserRow;
  trustedIdentityId: string | null;
  /** True when this transaction created the user row. */
  created: boolean;
}

/** The part of the `after` result that the new-user guard deletes. */
interface AfterSession {
  session: { id: string };
}

/** Runs inside the caller's transaction. */
async function linkInTransaction(
  tx: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
): Promise<Result<Linked>> {
  const identity = await tx.findOne("identity", [
    { field: "provider", op: "eq", value: provider },
    { field: "subject", op: "eq", value: profile.subject },
  ]);
  if (identity) {
    const user = await tx.findOne("user", [{ field: "id", op: "eq", value: identity.userId }]);
    if (!user) throw new Error("tempo-auth: identity without a user");
    // The provider's address is proof for this user only when it is this
    // user's address. A claimant who changes the provider address to one
    // they own must not verify the address they claimed.
    const proved =
      profile.emailVerified &&
      profile.email !== null &&
      normalizeEmail(profile.email) === user.email;
    if (!user.emailVerified && proved) {
      await claimEmail(tx, user.id, { identityId: identity.id }, now);
      await ensureEmailIdentity(tx, user.id, user.email, now);
      const filled = await fillUser(
        tx,
        { ...user, emailVerified: true, updatedAt: now },
        profile,
        now,
      );
      return ok({ user: filled, trustedIdentityId: null, created: false });
    }
    if (!user.emailVerified) {
      // No user-row write here. On D1 the undo of a user-row write restores
      // the full row and would revert a claim's emailVerified flip. The
      // verified sign-in later fills name and image.
      return ok({ user, trustedIdentityId: identity.id, created: false });
    }
    return ok({
      user: await fillUser(tx, user, profile, now),
      trustedIdentityId: proved ? null : identity.id,
      created: false,
    });
  }
  const email = profile.email ? normalizeEmail(profile.email) : null;
  if (!email) return fail("email_required");
  const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (existing) {
    if (!profile.emailVerified) return fail("email_taken_unverified");
    // An unverified account is a claim. The proof revokes earlier claimants
    // before the new identity is linked.
    let current = existing;
    if (!existing.emailVerified) {
      await claimEmail(tx, existing.id, null, now);
      current = { ...existing, emailVerified: true, updatedAt: now };
    }
    await tx.create("identity", identityRow(existing.id, provider, profile.subject, now));
    await ensureEmailIdentity(tx, existing.id, email, now);
    return ok({
      user: await fillUser(tx, current, profile, now),
      trustedIdentityId: null,
      created: false,
    });
  }
  const user = await tx.create("user", {
    id: newId(now),
    email,
    emailVerified: profile.emailVerified,
    name: profile.name,
    image: profile.image,
    createdAt: now,
    updatedAt: now,
  });
  const identityId = (
    await tx.create("identity", identityRow(user.id, provider, profile.subject, now))
  ).id;
  // The email identity means "this address signs in by magic link". It
  // exists only once the address is verified.
  if (profile.emailVerified) await tx.create("identity", identityRow(user.id, "email", email, now));
  // A claim can find this unverified user before the commit on D1.
  return ok({ user, trustedIdentityId: profile.emailVerified ? null : identityId, created: true });
}

function identityRow(userId: string, provider: string, subject: string, now: Date) {
  return {
    id: newId(now),
    userId,
    provider,
    subject,
    linkedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fills a null name or image. The caller has already marked the email verified through `claimEmail`. */
async function fillUser(
  tx: StorageAdapter,
  user: UserRow,
  profile: SocialProfile,
  now: Date,
): Promise<UserRow> {
  const patch: Partial<Pick<UserRow, "name" | "image">> = {};
  if (user.name === null && profile.name) patch.name = profile.name;
  if (user.image === null && profile.image) patch.image = profile.image;
  if (Object.keys(patch).length === 0) return user;
  await tx.update("user", [{ field: "id", op: "eq", value: user.id }], {
    ...patch,
    updatedAt: now,
  });
  return { ...user, ...patch, updatedAt: now };
}
