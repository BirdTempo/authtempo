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
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { buildQuery, type Provider, type SocialProfile } from "../social/provider.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { createSession } from "./sessions.js";
import { claimEmail, normalizeEmail } from "./users.js";

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

function findProvider(config: ResolvedConfig, name: string): Provider | undefined {
  return config.social.providers.find((p) => p.name === name);
}

function callbackUrl(config: ResolvedConfig, provider: Provider): string {
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
  const provider = findProvider(config, input.provider);
  if (!provider) return fail("not_found");
  if (!(await config.limiter.allow(`social-start:ip:${input.ip ?? "unknown"}`, START_LIMIT))) {
    return fail("rate_limited");
  }
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
    nonce,
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
  const provider = findProvider(config, input.provider);
  if (!provider) return fail("not_found");
  if (input.error) return fail("oauth_denied");
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
  if (row.identifier !== provider.name) return fail("invalid_token");
  const data = row.data as StateData | null;
  if (!data || typeof data.verifier !== "string") return fail("invalid_token");
  if (!input.bindToken || !constantTimeEqual(await sha256Hex(input.bindToken), data.bindHash)) {
    return fail("invalid_token");
  }
  if (!input.code) return fail("oauth_failed");

  const idToken = await exchangeCode(config, provider, input.code, data.verifier, now);
  if (idToken === null) return fail("oauth_failed");

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
    return fail("oauth_failed");
  }
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || !constantTimeEqual(await sha256Hex(nonce), data.nonceHash)) {
    console.error("tempo-auth: social nonce mismatch", provider.name);
    return fail("oauth_failed");
  }
  const profile = provider.profile(claims, { user: input.user ?? undefined });
  if (!profile.subject) return fail("oauth_failed");

  const resolved = await resolveSocialUser(config.storage, provider.name, profile, now);
  if (!resolved.ok) return resolved;
  const { token } = await createSession(config, {
    userId: resolved.value.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ token, next: safeNext(data.next), user: resolved.value });
}

/** The ID token from the token endpoint, or null on any failure. Logs the status only. */
async function exchangeCode(
  config: ResolvedConfig,
  provider: Provider,
  code: string,
  verifier: string,
  now: Date,
): Promise<string | null> {
  let res: Response;
  try {
    res = await config.social.fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: buildQuery({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(config, provider),
        client_id: provider.clientId,
        client_secret: await provider.clientSecret({ jwt: config.jwt, now }),
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
  const idToken = (body as { id_token?: unknown } | null)?.id_token;
  return typeof idToken === "string" && idToken.length > 0 ? idToken : null;
}

/**
 * Links the identity to a user by the spec's rules. One transaction per
 * attempt. A `unique_violation` is caught here, outside the transaction,
 * and the whole resolution runs once more against the winner's rows.
 */
export async function resolveSocialUser(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
): Promise<Result<UserRow>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await linkInTransaction(storage, provider, profile, now);
    } catch (err) {
      if (attempt === 0 && err instanceof StorageError && err.code === "unique_violation") continue;
      throw err;
    }
  }
}

function linkInTransaction(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
): Promise<Result<UserRow>> {
  return storage.transaction(async (tx) => {
    const identity = await tx.findOne("identity", [
      { field: "provider", op: "eq", value: provider },
      { field: "subject", op: "eq", value: profile.subject },
    ]);
    if (identity) {
      const user = await tx.findOne("user", [{ field: "id", op: "eq", value: identity.userId }]);
      if (!user) throw new Error("tempo-auth: identity without a user");
      if (!user.emailVerified && profile.emailVerified) {
        await claimEmail(tx, user.id, identity.id, now);
        await ensureEmailIdentity(tx, user.id, user.email, now);
        return ok(
          await fillUser(tx, { ...user, emailVerified: true, updatedAt: now }, profile, now),
        );
      }
      return ok(await fillUser(tx, user, profile, now));
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
      return ok(await fillUser(tx, current, profile, now));
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
    await tx.create("identity", identityRow(user.id, provider, profile.subject, now));
    // The email identity means "this address signs in by magic link". It
    // exists only once the address is verified.
    if (profile.emailVerified)
      await tx.create("identity", identityRow(user.id, "email", email, now));
    return ok(user);
  });
}

/** The email identity means "this address signs in by magic link". It exists once the address is proved. */
async function ensureEmailIdentity(
  tx: StorageAdapter,
  userId: string,
  email: string,
  now: Date,
): Promise<void> {
  const found = await tx.findOne("identity", [
    { field: "provider", op: "eq", value: "email" },
    { field: "subject", op: "eq", value: email },
  ]);
  if (!found) await tx.create("identity", identityRow(userId, "email", email, now));
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
