import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import type { Observer } from "../observe/observer.js";
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
import type { SessionRow, UserRow, VerificationPurpose } from "../schema.js";
import {
  buildQuery,
  type ConfiguredProvider,
  type OAuth2Provider,
  type OidcProvider,
  PROVIDER_TIMEOUT_MS,
  type Provider,
  type SocialProfile,
  stringClaim,
} from "../social/provider.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { type CreateSteps, createSteps, type VerifySteps, verifySteps } from "./create-steps.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, type IdentitySummary, runAfter, runBefore, stopWith } from "./hooks.js";
import { sendNotice } from "./notices.js";
import { gatedSteps, type SignInChallenge, touchTrust } from "./second-factor.js";
import {
  challengeOpened,
  endedList,
  type ResolvedSession,
  sessionIsLive,
  sessionOpened,
  sessionsEnded,
} from "./sessions.js";
import {
  type BeforeResolveWrite,
  ClaimLostError,
  ClaimRacedError,
  claimEmail,
  ensureEmailIdentity,
  normalizeEmail,
  undoSessionIfIdentityGone,
  userStillUnverified,
  validImageUrl,
  validUserName,
} from "./users.js";

export const OAUTH_STATE_PREFIX = "os_";
const STATE_RE = /^os_[A-Za-z0-9_-]{43}$/;
const STATE_TTL_MS = 10 * 60_000;
const START_LIMIT = { seconds: 15 * 60, max: 30 };
// Per 15 minutes, per user, after `social-start:ip` (plan 12a). A settings
// page links one or two providers; 10 bounds a stolen fresh session.
export const LINK_PER_USER = { seconds: 900, max: 10 };
/**
 * The state row of a link has its own purpose (plan 12a), as the codes of
 * plan 12a Task 3 do. The purpose alone picks the branch of the callback,
 * so a link state never opens a session, and a sign-in state never links.
 */
const LINK_STATE = "oauth-link-state";
const STATE_PURPOSES: readonly VerificationPurpose[] = ["oauth-state", LINK_STATE];

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
  /** The clear `td_` token of a trusted device (plan 12c). Apple's form post carries no `Lax` cookie; the challenge page offers the device then. */
  trustDevice?: string | undefined;
  /**
   * The session token of the callback request's cookie, or null (plan 12a).
   * A link callback needs the cookie of the session that started the link:
   * a browser that signed out, or that signed in as another account, must
   * not take the link. A sign-in callback does not read it.
   */
  sessionToken?: string | null | undefined;
}

interface StateData {
  verifier: string;
  nonceHash: string;
  bindHash: string;
  next: string;
  /** Set by `startLink` (plan 12a): the callback links to this user and this session, and opens no session. */
  link?: LinkTarget;
}

interface LinkTarget {
  userId: string;
  sessionId: string;
}

function findProvider(config: ResolvedConfig, name: string): ConfiguredProvider | undefined {
  return config.social.providers.find((p) => p.name === name);
}

/** The provider with its endpoints. A discovery entry reads them on first use (plan 9c). */
async function resolveProvider(
  config: ResolvedConfig,
  entry: ConfiguredProvider,
): Promise<Provider | null> {
  return entry.kind === "oidc-discovery"
    ? entry.resolve(config.social.fetch, config.observe)
    : entry;
}

function callbackUrl(config: ResolvedConfig, provider: { name: string }): string {
  return `${config.baseURL}${config.basePath}/social/${provider.name}/callback`;
}

/**
 * Writes one verification row that holds everything the callback needs,
 * then builds the authorize URL. The row's hash fields let the callback
 * check the nonce and the binding cookie without storing their clear values.
 * A link (plan 12a) writes its target into the row, under the link purpose.
 */
async function beginSocial(
  config: ResolvedConfig,
  input: SocialStart,
  link: LinkTarget | null,
): Promise<Result<SocialStarted>> {
  const entry = findProvider(config, input.provider);
  if (!entry) return fail("not_found");
  if (!(await limit(config, "social-start:ip", ipKey(input.ip), START_LIMIT))) {
    return fail("rate_limited");
  }
  if (link && !(await limit(config, "social-link:user", link.userId, LINK_PER_USER)))
    return fail("rate_limited");
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
    ...(link ? { link } : {}),
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: link ? LINK_STATE : "oauth-state",
    identifier: provider.name,
    valueHash: await sha256Hex(state),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
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

/** The start of a social sign-in. */
export function startSocial(
  config: ResolvedConfig,
  input: SocialStart,
): Promise<Result<SocialStarted>> {
  return beginSocial(config, input, null);
}

export interface SocialLinkStart {
  provider: string;
  session: ResolvedSession;
  next?: string | undefined;
  ip: string | null;
}

/**
 * The start of a link (plan 12a, spec 8.15): a fresh session of a verified
 * user adds a provider identity. An unverified user is a claim, and a claim
 * deletes identities, so a claimant has nothing to keep. PKCE, the nonce,
 * and the binding cookie are those of a sign-in. The checks run before the
 * limits, so a refused start counts no try.
 */
export async function startLink(
  config: ResolvedConfig,
  input: SocialLinkStart,
): Promise<Result<SocialStarted>> {
  const { user, session } = input.session;
  if (!user.emailVerified) return fail("email_unverified");
  const fresh = requireFresh(config, session);
  if (!fresh.ok) return fresh;
  return beginSocial(
    config,
    { provider: input.provider, next: input.next, ip: input.ip },
    { userId: user.id, sessionId: session.id },
  );
}

/** The answer of a link callback: the identity is linked, and no session opened. */
export interface SocialLinked {
  linked: true;
  next: string;
  user: UserRow;
}

/**
 * Consumes the state row first, so a replayed callback fails before any
 * network call. Then binds the browser, exchanges the code, verifies the
 * ID token and its nonce, and links or creates the user.
 */
export async function completeSocial(
  config: ResolvedConfig,
  input: SocialComplete,
): Promise<
  Result<{ token: string; next: string; user: UserRow } | SignInChallenge | SocialLinked>
> {
  const entry = findProvider(config, input.provider);
  if (!entry) return fail("not_found");
  const state = input.state ?? "";
  if (!STATE_RE.test(state)) return fail("invalid_token");
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(state) },
    { field: "purpose", op: "in", value: STATE_PURPOSES },
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
  // A link checks its session before any network call (plan 12a).
  const link =
    row.purpose === LINK_STATE ? await linkSession(config, entry, data, input, now) : null;
  if (link && !link.ok) return link;
  const provider = await resolveProvider(config, entry);
  if (!provider) return fail("oauth_failed");

  const token = await exchangeCode(config, provider, input.code, data.verifier, now);
  if (token === null) return fail("oauth_failed");
  const profile =
    provider.kind === "oidc"
      ? await idTokenProfile(config, provider, token, data.nonceHash, input.user ?? undefined, now)
      : await userinfoProfile(config, provider, token);
  const bounded = profile ? boundProfile(config.observe, profile, provider.name) : null;
  if (!bounded) return fail("oauth_failed");
  // A link (plan 12a): no session opens, and no sign-in gate applies.
  if (link)
    return completeLink(
      config,
      provider.name,
      bounded,
      link.value,
      safeNext(data.next),
      input,
      now,
    );

  // The session or the challenge commits with the claim in one transaction,
  // so a claimant's in-flight callback cannot keep a session the claim deleted.
  const ended = endedList(config);
  const next = safeNext(data.next);
  // The hook runs before the resolution's first write, for the D1 undo (see
  // `insertSignUp` in password.ts). A user with the second factor on gets a
  // challenge in place of the session (plan 12c). A new identity of a
  // verified user commits with the challenge: the link alone opens nothing,
  // and a later sign-in through it meets the gate again (spec 9).
  const steps = gatedSteps(
    config,
    {
      ip: input.ip,
      userAgent: input.userAgent,
      via: "social",
      next,
      trustDevice: input.trustDevice,
      gate: config.totp?.gate.social ?? false,
    },
    now,
  );
  // The user and identity hooks, with the sign-up rule first (plan 12a).
  const made = createSteps(config, "social", { signUpRule: true });
  // The verify hooks of an unverified user that this sign-in claims (plan 12a, Task 18).
  const verified = verifySteps(config, "social");
  const resolved = await hookGuard(() =>
    resolveSocialUser(
      config.storage,
      provider.name,
      bounded,
      now,
      verified,
      (tx) => steps.write(tx),
      ended,
      steps.before,
      made,
    ),
  );
  if (!resolved.ok) return resolved;
  const { user, after } = resolved.value;
  // After the commit, before the session hook and before a challenge answer (plan 12a).
  await verified.after(user);
  await made.after(user);
  await sessionsEnded(config, ended, "claim", verified.stops, verified.endedCount());
  if (after.kind === "challenge") {
    challengeOpened(config, user, "social");
    return ok({ ...after.pending, next, user });
  }
  await touchTrust(config, steps.trustId(), now);
  await sessionOpened(config, after.session, user, "social", provider.name);
  return ok({ token: after.token, next, user });
}

/** The session of a link's start, as `linkSession` read it. */
interface HeldLink {
  userId: string;
  session: SessionRow;
}

/**
 * The session of a link's start, read before the provider step's network
 * call (plan 12a). The row must be live: a sign-out or a revoke since the
 * start ends the link. The callback must carry the cookie of that session.
 * Apple's callback is a cross-site form post, and a browser sends no `Lax`
 * cookie with it, so with `cookie.sameSite: "Lax"` the binding cookie alone
 * ties that callback to the browser.
 */
async function linkSession(
  config: ResolvedConfig,
  entry: ConfiguredProvider,
  data: StateData,
  input: SocialComplete,
  now: Date,
): Promise<Result<HeldLink>> {
  const target = data.link;
  // `beginSocial` writes a target into every link row; the check narrows the type.
  if (!target) return fail("invalid_token");
  const session = await config.storage.findOne("session", [
    { field: "id", op: "eq", value: target.sessionId },
  ]);
  if (!session || !sessionIsLive(config, session, now)) return fail("invalid_token");
  if (input.sessionToken) {
    if (!constantTimeEqual(await sha256Hex(input.sessionToken), session.tokenHash))
      return fail("invalid_token");
  } else if (entry.callbackMethod === "GET" || config.cookie.sameSite === "None") {
    return fail("invalid_token");
  }
  return ok({ userId: target.userId, session });
}

/**
 * The link branch of the callback (plan 12a). A provider account that a
 * user holds stays with that user: core never moves an identity. The
 * provider address must be present, verified by the provider, and equal to
 * the user's address (owner decision 4). No user row is written: a link
 * fills no name and no image.
 */
async function completeLink(
  config: ResolvedConfig,
  provider: string,
  profile: SocialProfile,
  held: HeldLink,
  next: string,
  input: SocialComplete,
  now: Date,
): Promise<Result<SocialLinked>> {
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: held.userId },
  ]);
  if (!user) return fail("invalid_token");
  const byKey: Where<"identity">[] = [
    { field: "provider", op: "eq", value: provider },
    { field: "subject", op: "eq", value: profile.subject },
  ];
  // The caller proved this provider account at the provider. A social
  // sign-in with it opens the account that holds it, so the answer tells
  // the caller nothing that the provider account does not give.
  const found = await config.storage.findOne("identity", byKey);
  if (found)
    return found.userId === user.id ? ok({ linked: true, next, user }) : fail("identity_taken");
  const email = profile.email ? normalizeEmail(profile.email) : null;
  if (email === null) return fail("email_required");
  if (!profile.emailVerified || email !== user.email) return fail("email_mismatch");
  const identity: IdentitySummary = { provider, subject: profile.subject };
  try {
    const linked = await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<true>> => {
        await runBefore(config.observe, "identity.beforeLink", config.hooks.identity.beforeLink, {
          user,
          identity,
          via: "link",
        });
        await tx.create("identity", identityRow(user.id, provider, profile.subject, now));
        // The last statement: a sign-out or a revoke since the read deletes
        // the row, and the link undoes. A session ends only by its delete,
        // and the read saw the row live at `now`, so the id alone decides.
        const live = await tx.update(
          "session",
          [{ field: "id", op: "eq", value: held.session.id }],
          {
            updatedAt: now,
          },
        );
        if (live !== 1) stopWith("invalid_token");
        return ok(true);
      }),
    );
    if (!linked.ok) return linked;
  } catch (err) {
    // Another callback linked the provider account first. Caught outside
    // the transaction: inside, Postgres has already aborted it. The
    // winner's row decides: the same user is linked, another user holds it.
    if (
      err instanceof StorageError &&
      err.code === "unique_violation" &&
      err.model === "identity"
    ) {
      const winner = await config.storage.findOne("identity", byKey);
      return winner?.userId === user.id ? ok({ linked: true, next, user }) : fail("identity_taken");
    }
    throw err;
  }
  await runAfter(
    config.observe,
    "identity.afterLink",
    config.hooks.identity.afterLink,
    { user, identity, via: "link" },
    user.id,
  );
  // After the commit, never inside the transaction (plan 12a Task 6).
  await sendNotice(config, {
    event: "identity_linked",
    email: user.email,
    provider,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ linked: true, next, user });
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
    config.observe.emit({
      name: "social.client_secret_failed",
      provider: provider.name,
      errorClass: e,
    });
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
    config.observe.emit({
      name: "social.token_request_failed",
      provider: provider.name,
      errorClass: e,
    });
    return null;
  }
  if (!res.ok) {
    config.observe.emit({
      name: "social.token_status",
      provider: provider.name,
      status: res.status,
    });
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
  config.observe.emit({ name: "social.token_missing", provider: provider.name });
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
    config.observe.emit({
      name: "social.id_token_rejected",
      provider: provider.name,
      errorClass: e,
    });
    return null;
  }
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || !constantTimeEqual(await sha256Hex(nonce), nonceHash)) {
    config.observe.emit({ name: "social.nonce_mismatch", provider: provider.name });
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
    config.observe.emit({ name: "social.user_info_failed", provider: provider.name, errorName: e });
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
function boundProfile(
  observe: Observer,
  profile: SocialProfile,
  providerName: string,
): SocialProfile | null {
  const subject = profile.subject;
  if (
    subject.length < 1 ||
    subject.length > SUBJECT_MAX ||
    hasControlChar(subject) ||
    subject.trim().length === 0
  ) {
    observe.emit({ name: "social.bad_subject", provider: providerName });
    return null;
  }
  const { name, image } = profile;
  return {
    ...profile,
    name: name !== null && validUserName(name) ? name : null,
    // The profile's image rule (plan 12a): one rule for the fill, the hook patch, and the update.
    image: image !== null && validImageUrl(image) ? image : null,
  };
}

/** The identity row's subject. 255 covers every provider id we know and bounds the row. */
const SUBJECT_MAX = 255;
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
  verified: VerifySteps,
): Promise<Result<UserRow>>;
export function resolveSocialUser<T extends AfterWrite>(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
  verified: VerifySteps,
  after: (tx: StorageAdapter, user: UserRow) => Promise<T>,
  ended?: SessionRow[],
  before?: BeforeResolveWrite,
  steps?: CreateSteps,
): Promise<Result<{ user: UserRow; after: T }>>;
export async function resolveSocialUser<T extends AfterWrite>(
  storage: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
  verified: VerifySteps,
  after?: (tx: StorageAdapter, user: UserRow) => Promise<T>,
  ended?: SessionRow[],
  before?: BeforeResolveWrite,
  steps?: CreateSteps,
): Promise<Result<UserRow> | Result<{ user: UserRow; after: T }>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await storage.transaction(
        async (tx): Promise<Result<UserRow> | Result<{ user: UserRow; after: T }>> => {
          // A retry runs the claim again. The rows of an attempt that rolled back did not end.
          if (ended) ended.length = 0;
          // A retry forgets the user and the identity of the attempt that rolled back.
          steps?.begin();
          verified.begin();
          const linked = await linkInTransaction(
            tx,
            provider,
            profile,
            now,
            verified,
            ended,
            before ? (user, created) => before(tx, user, created) : undefined,
            steps,
          );
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
              // The row that `after` wrote. A created user has no factor, so
              // it is a session; the challenge branch keeps the rule whole.
              if (value.kind === "session")
                await tx.delete("session", [{ field: "id", op: "eq", value: value.session.id }]);
              else await tx.delete("verification", [{ field: "id", op: "eq", value: value.id }]);
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
      // Another proof claimed the user first (review M1): the retry signs in the verified user.
      if (attempt === 0 && err instanceof ClaimLostError) continue;
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

/** The part of the `after` result that the new-user guard deletes: the session or the challenge that `after` wrote (plan 12c). */
type AfterWrite = { kind: "session"; session: { id: string } } | { kind: "challenge"; id: string };

/** Runs inside the caller's transaction. */
async function linkInTransaction(
  tx: StorageAdapter,
  provider: string,
  profile: SocialProfile,
  now: Date,
  verified: VerifySteps,
  ended: SessionRow[] | undefined,
  before: ((user: UserRow, created: boolean) => Promise<void>) | undefined,
  steps: CreateSteps | undefined,
): Promise<Result<Linked>> {
  // Each branch calls `before` with the user it answers, after its checks and
  // before its first write: the D1 undo (see `insertSignUp` in password.ts).
  const identity = await tx.findOne("identity", [
    { field: "provider", op: "eq", value: provider },
    { field: "subject", op: "eq", value: profile.subject },
  ]);
  if (identity) {
    const user = await tx.findOne("user", [{ field: "id", op: "eq", value: identity.userId }]);
    if (!user) throw new Error("authtempo: identity without a user");
    // The provider's address is proof for this user only when it is this
    // user's address. A claimant who changes the provider address to one
    // they own must not verify the address they claimed.
    const proved =
      profile.emailVerified &&
      profile.email !== null &&
      normalizeEmail(profile.email) === user.email;
    if (!user.emailVerified && proved) {
      const claimed = { ...user, emailVerified: true, updatedAt: now };
      const filled = filledUser(claimed, profile, now);
      // `user.beforeVerify`, then the session hook, before the first write (plan 12a).
      await verified.before(user);
      if (before) await before(filled, false);
      await claimEmail(tx, user.id, { identityId: identity.id }, now, verified, ended);
      await ensureEmailIdentity(tx, user.id, user.email, now);
      await writeFill(tx, claimed, filled);
      return ok({ user: filled, trustedIdentityId: null, created: false });
    }
    if (!user.emailVerified) {
      // No user-row write here. On D1 the undo of a user-row write restores
      // the full row and would revert a claim's emailVerified flip. The
      // verified sign-in later fills name and image.
      if (before) await before(user, false);
      return ok({ user, trustedIdentityId: identity.id, created: false });
    }
    const filled = filledUser(user, profile, now);
    if (before) await before(filled, false);
    await writeFill(tx, user, filled);
    return ok({ user: filled, trustedIdentityId: proved ? null : identity.id, created: false });
  }
  const email = profile.email ? normalizeEmail(profile.email) : null;
  if (!email) return fail("email_required");
  const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (existing) {
    if (!profile.emailVerified) return fail("email_taken_unverified");
    // An unverified account is a claim. The proof revokes earlier claimants
    // before the new identity is linked.
    const current = existing.emailVerified
      ? existing
      : { ...existing, emailVerified: true, updatedAt: now };
    const filled = filledUser(current, profile, now);
    const linking: IdentitySummary = { provider, subject: profile.subject };
    // `user.beforeVerify`, `identity.beforeLink`, then the session hook,
    // before the first write (plan 12a).
    if (!existing.emailVerified) await verified.before(existing);
    if (steps) await steps.identity(filled, linking);
    if (before) await before(filled, false);
    if (!existing.emailVerified) await claimEmail(tx, existing.id, null, now, verified, ended);
    await tx.create("identity", identityRow(existing.id, provider, profile.subject, now));
    await ensureEmailIdentity(tx, existing.id, email, now);
    await writeFill(tx, current, filled);
    return ok({ user: filled, trustedIdentityId: null, created: false });
  }
  const drafted: UserRow = {
    id: newId(now),
    email,
    emailVerified: profile.emailVerified,
    name: profile.name,
    image: profile.image,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    createdAt: now,
    updatedAt: now,
  };
  const linking: IdentitySummary = { provider, subject: profile.subject };
  // The sign-up rule and `user.beforeCreate`, then `identity.beforeLink`, then
  // the session hook, all before the user create (plan 12a, spec 8.9).
  const minted = steps ? await steps.user(tx, drafted) : drafted;
  if (steps) await steps.identity(minted, linking);
  if (before) await before(minted, true);
  const user = await tx.create("user", minted);
  const identityId = (
    await tx.create("identity", identityRow(user.id, provider, profile.subject, now))
  ).id;
  // The email identity means "this address signs in by magic link". It
  // exists only once the address is verified.
  if (profile.emailVerified) await tx.create("identity", identityRow(user.id, "email", email, now));
  // A claim can find this unverified user before the commit on D1.
  return ok({
    user,
    trustedIdentityId: profile.emailVerified ? null : identityId,
    created: true,
  });
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

/**
 * The user with a null name or image filled from the profile, with no
 * write, so the session hook sees the row the flow leaves. The caller has
 * already marked the email verified, or does so through `claimEmail`.
 */
function filledUser(user: UserRow, profile: SocialProfile, now: Date): UserRow {
  const patch: Partial<Pick<UserRow, "name" | "image">> = {};
  if (user.name === null && profile.name) patch.name = profile.name;
  if (user.image === null && profile.image) patch.image = profile.image;
  if (Object.keys(patch).length === 0) return user;
  return { ...user, ...patch, updatedAt: now };
}

/**
 * Writes the fill of `filledUser`, or nothing when it filled nothing. Each
 * field is written only while it is still null (plan 12a fix wave, final
 * review m1; spec 8.15 item 10): a profile update that commits between the
 * flow's read and this write keeps its value. One write per field, so an
 * update of the name does not stop the fill of an empty image.
 */
async function writeFill(tx: StorageAdapter, user: UserRow, filled: UserRow): Promise<void> {
  const byId = { field: "id", op: "eq", value: user.id } as const;
  if (filled.name !== user.name)
    await tx.update("user", [byId, { field: "name", op: "eq", value: null }], {
      name: filled.name,
      updatedAt: filled.updatedAt,
    });
  if (filled.image !== user.image)
    await tx.update("user", [byId, { field: "image", op: "eq", value: null }], {
      image: filled.image,
      updatedAt: filled.updatedAt,
    });
}
