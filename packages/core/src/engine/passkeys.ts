import { CREDENTIAL_ID_MAX_BYTES } from "../bounds.js";
import { checkCaptcha } from "../captcha.js";
import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { fromBase64Url, randomBase64Url, sha256Hex, toBase64Url } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { PasskeyHint } from "../primitives/passkey-hints.js";
import { fail, ok, type Result } from "../result.js";
import type { PasskeyRow, SessionRow, UserRow, VerificationRow } from "../schema.js";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "../seams/webauthn.js";
import { StorageError, type Where } from "../storage/port.js";
import { passkeyUserName, provedAccount } from "./address.js";
import {
  type AnonymousCaller,
  anonymousData,
  recordedAnonymous,
  upgradeProof,
  upgradeSteps,
} from "./anonymous.js";
import { createSteps } from "./create-steps.js";
import { hookGuard } from "./hooks.js";
import { guardedRemove } from "./identities.js";
import { sendNotice } from "./notices.js";
import {
  type PasskeySignInExtensions,
  registrationExtensions,
  signInExtensions,
  storedFlags,
  withExtensions,
  withoutSecretOutputs,
} from "./passkey-extensions.js";
import { FactorRaceError, factorRow, later } from "./second-factor.js";
import { prepareSession, sessionOpened, writeSession } from "./sessions.js";
import { enforcedAnswer } from "./sso/enforce.js";
import { draftUserRow, mayCreateUser, validShownName } from "./users.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const SIGN_IN = "sign-in";
/** The identifier of a sign-up challenge row: no user exists yet (plan 12i Task 8). */
const SIGN_UP = "sign-up";
const OPTIONS_LIMIT = { seconds: 15 * 60, max: 30 };
const VERIFY_LIMIT = { seconds: 15 * 60, max: 20 };

/**
 * The renames of one user's passkeys: 30 per 15 minutes on the key
 * `passkey-rename:user:<userId>` (plan 12a Task 19). A settings page renames
 * by hand, so 30 leaves room. The README "Account" table and the limits page
 * state the same key, window, and count.
 */
export const RENAME_PER_USER = { seconds: 900, max: 30 };

/**
 * The options of a passkey-first sign-up: 10 per hour on the key
 * `passkey-sign-up:ip:<ip>` (plan 12i Task 8). Each call writes a challenge
 * row, and its verify writes a user. The limits page states the same key,
 * window, and count.
 */
export const SIGN_UP_PER_IP = { seconds: 3600, max: 10 };
/** The window of the daily cap (ruling 38 M3). The max is `passkey.signUp.dailyCap`. */
const SIGN_UP_CAP_WINDOW_SECONDS = 86_400;
/** The subject of the daily cap: one count for the deployment. */
const SIGN_UP_CAP_SUBJECT = "deployment";

/**
 * The longest name of a passkey-first sign-up, in UTF-16 code units (plan
 * 12i Task 8). The name is the WebAuthn `user.name` and `displayName`. An
 * authenticator may cut a long name, so the list of the device could show
 * two accounts with one name.
 */
const SIGN_UP_NAME_MAX = 80;

/** The longest passkey name, in UTF-16 code units: the bound of the registration since plan 4. */
const PASSKEY_NAME_MAX = 64;

/**
 * The passkey name rule: the character rule of a user name, with at most 64
 * code units (plan 12a Task 19). The device list and the notices show the
 * name, so a bidi override must not make one passkey read as another. The
 * rename refuses a name that breaks it; the registration stores no name.
 */
function validPasskeyName(name: string): boolean {
  return validShownName(name, PASSKEY_NAME_MAX);
}

/**
 * The stored name of a registration (plan 12a Task 19, review M2). The device
 * has made its credential before the server sees the name, so a name never
 * refuses the credential. A name that is blank after the trim, or that breaks
 * the passkey name rule, is stored as no name, as the social fill does. Only
 * the rename refuses such a name.
 */
function registeredName(name: string | undefined): string | null {
  if (name === undefined || name.trim() === "") return null;
  return validPasskeyName(name) ? name : null;
}

/**
 * `second-factor`: a ceremony bound to one `tf_` challenge (plan 12c).
 * `reauth`: a re-authentication of one signed-in user (plan 12a).
 * `sign-up`: the registration of a passkey-first sign-up (plan 12i Task 8).
 */
type Kind = "registration" | "authentication" | "second-factor" | "reauth" | "sign-up";

export interface PasskeySummary {
  id: string;
  credentialId: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  /**
   * The extension flags of the registration (plan 12i): advice for the
   * app's own client from unsigned outputs. No check of core reads them.
   */
  discoverable: boolean | null;
  prf: boolean;
  largeBlob: boolean;
  createdAt: Date;
}

function summary(row: PasskeyRow): PasskeySummary {
  return {
    id: row.id,
    credentialId: row.credentialId,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    discoverable: row.discoverable,
    prf: row.prf,
    largeBlob: row.largeBlob,
    createdAt: row.createdAt,
  };
}

/**
 * The user handle of a passkey: the bytes of the user id (plan 4). The
 * registration options carry them, and `GET /passkeys` answers their
 * base64url form for `signalAllAcceptedCredentials` (plan 12i).
 */
function userHandleOf(userId: string): Uint8Array {
  return new TextEncoder().encode(userId);
}

/**
 * The options with the hints of the ceremony (WebAuthn Level 3, plan 12i).
 * The hints of the request replace the config's list. No hint leaves the
 * library's own value, which is no key or an empty list.
 */
function withHints<T extends object>(options: T, hints: readonly PasskeyHint[]): T {
  return hints.length === 0 ? options : { ...options, hints: [...hints] };
}

/** Writes the challenge row and returns the challenge bytes and their base64url form. `extra` joins `data`. */
async function issueChallenge(
  config: ResolvedConfig,
  identifier: string,
  kind: Kind,
  extra: Record<string, unknown> = {},
): Promise<{ bytes: Uint8Array; text: string }> {
  const now = config.clock.now();
  const text = randomBase64Url(32);
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "passkey-challenge",
    identifier,
    valueHash: await sha256Hex(text),
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    consumedAt: null,
    data: { kind, ...extra },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  return { bytes: fromBase64Url(text), text };
}

/**
 * The challenge the browser signed, read from the client data. The seam
 * checks it again; this read only selects the row to consume.
 */
function challengeFromResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const inner = (response as { response?: unknown }).response;
  if (typeof inner !== "object" || inner === null) return null;
  const clientDataJSON = (inner as { clientDataJSON?: unknown }).clientDataJSON;
  if (typeof clientDataJSON !== "string") return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(clientDataJSON))) as {
      challenge?: unknown;
    };
    return typeof parsed.challenge === "string" && parsed.challenge.length > 0
      ? parsed.challenge
      : null;
  } catch {
    return null;
  }
}

/** Consumes the row for this challenge, identifier, and kind. The same conditional update as the magic link. */
async function consumeChallenge(
  config: ResolvedConfig,
  challenge: string,
  identifier: string,
  kind: Kind,
  bind?: string,
): Promise<Result<VerificationRow>> {
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(challenge) },
    { field: "purpose", op: "eq", value: "passkey-challenge" },
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
  // The row is spent whatever comes next, so a challenge issued for one
  // user or one ceremony cannot be retried for another. The identifier alone
  // separates the two ceremonies (a user id against "sign-in"); the kind
  // clause is a second guard that no test can isolate.
  const data = row.data as { kind?: unknown; challengeId?: unknown } | null;
  if (row.identifier !== identifier || data?.kind !== kind) return fail("invalid_token");
  // A second-factor ceremony is bound to one `tf_` challenge (plan 12c, ASVS
  // 5.0 6.6.2): an assertion for one sign-in does not pass at another.
  if (bind !== undefined && data?.challengeId !== bind) return fail("invalid_token");
  return ok(row);
}

export async function passkeyRegistrationOptions(
  config: ResolvedConfig,
  input: { user: UserRow; hints?: PasskeyHint[] | undefined },
): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> {
  if (!config.passkey) return fail("not_found");
  if (!provedAccount(input.user)) return fail("email_unverified");
  const existing = await config.storage.findMany("passkey", [
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  const { bytes } = await issueChallenge(config, input.user.id, "registration");
  const options = await config.webauthn.registrationOptions({
    rpID: config.passkey.rpID,
    rpName: config.passkey.rpName,
    userID: userHandleOf(input.user.id),
    userName: passkeyUserName(config, input.user),
    userDisplayName: input.user.name ?? passkeyUserName(config, input.user),
    challenge: bytes,
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: p.transports ? p.transports.split(",") : null,
    })),
  });
  return ok(
    withHints(
      withExtensions(options, registrationExtensions(config.passkey)),
      input.hints ?? config.passkey.hints.register,
    ),
  );
}

/** The bytes that a base64url text without padding decodes to. */
function base64UrlBytes(text: string): number {
  return Math.floor((text.length * 3) / 4);
}

export async function verifyPasskeyRegistration(
  config: ResolvedConfig,
  input: { user: UserRow; response: unknown; name?: string | undefined },
): Promise<Result<PasskeySummary>> {
  if (!config.passkey) return fail("not_found");
  // First: no read, store, or log sees a PRF output or a large blob (plan 12i).
  const response = withoutSecretOutputs(input.response);
  if (!provedAccount(input.user)) return fail("email_unverified");
  const challenge = challengeFromResponse(response);
  if (!challenge) return fail("invalid_token");
  const consumed = await consumeChallenge(config, challenge, input.user.id, "registration");
  if (!consumed.ok) return consumed;
  let registered: Awaited<ReturnType<typeof config.webauthn.verifyRegistration>>;
  try {
    registered = await config.webauthn.verifyRegistration({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.passkey.origins,
      expectedRPID: config.passkey.rpID,
    });
  } catch (e) {
    config.observe.emit({ name: "passkey.registration_rejected", errorClass: e });
    return fail("passkey_failed");
  }
  // WebAuthn Level 3 bounds a credential id to 1023 bytes. The MySQL column
  // holds its base64url form of 1364 characters (ruling 7 of plan 12g).
  // An id over the bound answers like any other failed ceremony.
  if (base64UrlBytes(registered.id) > CREDENTIAL_ID_MAX_BYTES) {
    config.observe.emit({ name: "passkey.credential_id_too_long" });
    return fail("passkey_failed");
  }
  const now = config.clock.now();
  let row: PasskeyRow;
  try {
    row = await config.storage.create("passkey", {
      id: newId(now),
      userId: input.user.id,
      credentialId: registered.id,
      publicKey: toBase64Url(registered.publicKey),
      counter: registered.counter,
      transports: registered.transports ? registered.transports.join(",") : null,
      deviceType: registered.deviceType,
      backedUp: registered.backedUp,
      name: registeredName(input.name),
      // Advice from unsigned outputs (plan 12i): no check reads them.
      ...storedFlags(config.passkey, response),
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    // The credential id is unique across users. A second registration of
    // the same authenticator answers like any other failed ceremony.
    if (e instanceof StorageError && e.code === "unique_violation" && e.model === "passkey") {
      config.observe.emit({ name: "passkey.already_registered" });
      return fail("passkey_failed");
    }
    throw e;
  }
  // After the write (plan 12a). The create is one statement, with no transaction.
  config.observe.emit({ name: "passkey.register", outcome: "success", userId: input.user.id });
  await sendNotice(config, {
    event: "passkey_added",
    email: input.user.email,
    ip: null,
    userAgent: null,
  });
  return ok(summary(row));
}

export interface PasskeySignUpOptions {
  /** The name of the person: the WebAuthn `user.name` and `displayName`, and the user's name. */
  name: string;
  ip: string | null;
  hints?: PasskeyHint[] | undefined;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
  /** The live anonymous session of the request (plan 12i Task 7): the row records its user. */
  anonymous?: AnonymousCaller | null | undefined;
}

/**
 * `POST /passkey/sign-up/options` (plan 12i Task 8, spec 32 item 2). The
 * name rule, the sign-up rule, the per-IP limit, the captcha, and the
 * daily cap of the deployment come first, in that order. A failed captcha
 * does not count against the cap. Then the user id is minted, and a
 * challenge row keeps it with the name for 5 minutes. No user row exists
 * until the verify. The options carry no address and no data of another
 * user: the user handle is the new id, and the user name is the name given.
 */
export async function passkeySignUpOptions(
  config: ResolvedConfig,
  input: PasskeySignUpOptions,
): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> {
  const rp = config.passkey;
  if (!rp?.signUp) return fail("not_found");
  // Before the limit, so a refused body counts no try.
  if (input.name.trim() === "" || !validShownName(input.name, SIGN_UP_NAME_MAX))
    return fail("invalid_body");
  // A user with no address passes only "open": an invitation names an address (plan 12b).
  // The verify runs the rule again in its transaction. The config can change in between.
  if (config.signUp !== "open") return fail("sign_up_closed");
  if (!(await limit(config, "passkey-sign-up:ip", ipKey(input.ip), SIGN_UP_PER_IP)))
    return fail("rate_limited");
  const captcha = await checkCaptcha(config, "passkey-sign-up", input.captchaToken, input.ip);
  if (captcha) return captcha;
  // A software authenticator makes a user per verify. The cap bounds the
  // users of a day (ruling 38 M3).
  const cap = { seconds: SIGN_UP_CAP_WINDOW_SECONDS, max: rp.signUp.dailyCap };
  if (!(await limit(config, "passkey-sign-up:all-day", SIGN_UP_CAP_SUBJECT, cap)))
    return fail("rate_limited");
  const userId = newId(config.clock.now());
  const { bytes } = await issueChallenge(config, SIGN_UP, "sign-up", {
    userId,
    name: input.name,
    ...anonymousData(input.anonymous),
  });
  const options = await config.webauthn.registrationOptions({
    rpID: rp.rpID,
    rpName: rp.rpName,
    userID: userHandleOf(userId),
    userName: input.name,
    userDisplayName: input.name,
    challenge: bytes,
    excludeCredentials: [],
  });
  return ok(
    withHints(
      withExtensions(options, registrationExtensions(rp)),
      input.hints ?? rp.hints.register,
    ),
  );
}

/** The user id and the name that the options kept in the challenge row, or null. */
function signUpData(data: unknown): { userId: string; name: string } | null {
  const d = data as { userId?: unknown; name?: unknown } | null;
  return typeof d?.userId === "string" && typeof d.name === "string"
    ? { userId: d.userId, name: d.name }
    : null;
}

export interface PasskeySignUpVerify {
  response: unknown;
  ip: string | null;
  userAgent: string | null;
  /**
   * The live anonymous session of the verify (plan 12i Task 7). The
   * registration completes in this request, so the sign-up is bound: the
   * row's anonymous user links, or with none, this one.
   */
  anonymous?: AnonymousCaller | null | undefined;
}

/**
 * `POST /passkey/sign-up/verify` (plan 12i Task 8, spec 32 item 2). The
 * conditional consume of the challenge row, so a challenge makes one user.
 * Then the check of the seam, with user verification required. Then one
 * transaction: the sign-up rule for a null address, `user.beforeCreate`
 * with `via: "passkey"`, the anonymous upgrade, and the session hook, all
 * before the first write. Then the passkey row, the user row, the claim of
 * the upgrade, and the session.
 *
 * The passkey row comes first. A credential id that exists answers
 * `passkey_failed` by its unique key, and the transaction has written
 * nothing. There is no gate (Review Focus 1): a new user has no factor,
 * and a passkey with user verification is two factors. The new user has no
 * address, so it can claim or link no user with an address. The only link
 * is the upgrade of an anonymous user.
 */
export async function verifyPasskeySignUp(
  config: ResolvedConfig,
  input: PasskeySignUpVerify,
): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>> {
  const rp = config.passkey;
  if (!rp?.signUp) return fail("not_found");
  // First: no read, store, or log sees a PRF output or a large blob (plan 12i).
  const response = withoutSecretOutputs(input.response);
  if (!(await limit(config, "passkey-verify:ip", ipKey(input.ip), VERIFY_LIMIT)))
    return fail("rate_limited");
  const challenge = challengeFromResponse(response);
  if (!challenge) return fail("invalid_token");
  const consumed = await consumeChallenge(config, challenge, SIGN_UP, "sign-up");
  if (!consumed.ok) return consumed;
  const data = signUpData(consumed.value.data);
  if (!data) return fail("invalid_token");
  let registered: Awaited<ReturnType<typeof config.webauthn.verifyRegistration>>;
  try {
    registered = await config.webauthn.verifyRegistration({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
    });
  } catch (e) {
    config.observe.emit({ name: "passkey.registration_rejected", errorClass: e });
    return fail("passkey_failed");
  }
  if (base64UrlBytes(registered.id) > CREDENTIAL_ID_MAX_BYTES) {
    config.observe.emit({ name: "passkey.credential_id_too_long" });
    return fail("passkey_failed");
  }
  const now = config.clock.now();
  const upgrade = upgradeSteps(
    config,
    input.anonymous ?? null,
    recordedAnonymous(consumed.value.data),
    "bound",
  );
  // No sign-up rule in the steps: the transaction runs `mayCreateUser` for the null address.
  const made = createSteps(config, "passkey", { signUpRule: false });
  let opened: Result<{ user: UserRow; token: string; session: SessionRow }>;
  try {
    opened = await hookGuard(async () =>
      ok(
        await config.storage.transaction(async (tx) => {
          made.begin();
          await mayCreateUser(config, tx, null);
          const user = await made.user(
            tx,
            draftUserRow(
              { id: data.userId, email: null, emailVerified: false, name: data.name },
              now,
            ),
          );
          // Every hook runs before the first write: the D1 undo (`BeforeResolveWrite` in users.ts).
          await upgrade.before(tx, user, upgradeProof(user), "passkey");
          const prepared = await prepareSession(
            config,
            { user, ip: input.ip, userAgent: input.userAgent, via: "passkey" },
            tx,
          );
          await tx.create("passkey", {
            id: newId(now),
            userId: user.id,
            credentialId: registered.id,
            publicKey: toBase64Url(registered.publicKey),
            counter: registered.counter,
            transports: registered.transports ? registered.transports.join(",") : null,
            deviceType: registered.deviceType,
            backedUp: registered.backedUp,
            name: null,
            // Advice from unsigned outputs (plan 12i): no check reads them.
            ...storedFlags(rp, response),
            createdAt: now,
            updatedAt: now,
          });
          await tx.create("user", user);
          await upgrade.claim(tx);
          return { user, ...(await writeSession(config, prepared, tx)) };
        }),
      ),
    );
  } catch (e) {
    // The credential id is unique across users: the authenticator holds a passkey of a user.
    if (e instanceof StorageError && e.code === "unique_violation" && e.model === "passkey") {
      config.observe.emit({ name: "passkey.already_registered" });
      return fail("passkey_failed");
    }
    throw e;
  }
  if (!opened.ok) return opened;
  const { user, token, session } = opened.value;
  await made.after(user);
  config.observe.emit({ name: "passkey.register", outcome: "success", userId: user.id });
  await sessionOpened(config, session, user, "passkey");
  await upgrade.after();
  return ok({ token, user, session });
}

export async function passkeyAuthenticationOptions(
  config: ResolvedConfig,
  input: {
    ip: string | null;
    hints?: PasskeyHint[] | undefined;
    extensions?: PasskeySignInExtensions | undefined;
    /** The live anonymous session of the request (plan 12i Task 7): the row records its user. */
    anonymous?: AnonymousCaller | null | undefined;
  },
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  if (!config.passkey) return fail("not_found");
  // Before the limit, so a refused body counts no try.
  const extensions = signInExtensions(config.passkey, input.extensions);
  if (!extensions.ok) return extensions;
  if (!(await limit(config, "passkey-options:ip", ipKey(input.ip), OPTIONS_LIMIT))) {
    return fail("rate_limited");
  }
  const { bytes } = await issueChallenge(
    config,
    SIGN_IN,
    "authentication",
    anonymousData(input.anonymous),
  );
  const options = await config.webauthn.authenticationOptions({
    rpID: config.passkey.rpID,
    challenge: bytes,
  });
  return ok(
    withHints(
      withExtensions(options, extensions.value),
      input.hints ?? config.passkey.hints.signIn,
    ),
  );
}

/**
 * The assertion check of a sign-in and of the second factor (plan 12c): the
 * credential, the seam, and the counter compare-and-set. With `userId`, the
 * credential must be one of that user's passkeys. A credential with no row
 * answers `passkey_unknown`, so the client can call `signalUnknownCredential`
 * (WebAuthn Level 3, plan 12i, spec 32 item 3). Only the holder of the
 * credential learns it: the id is random, and the person's own
 * authenticator gives it. A credential of another user and a bad signature
 * answer `passkey_failed`. The caller has consumed the challenge row first.
 */
async function checkAssertion(
  config: ResolvedConfig,
  response: unknown,
  challenge: string,
  userId: string | null,
): Promise<Result<PasskeyRow>> {
  const rp = config.passkey;
  if (!rp) return fail("not_found");
  const credentialId = (response as { id?: unknown }).id;
  if (typeof credentialId !== "string") return fail("passkey_failed");
  const passkey = await config.storage.findOne("passkey", [
    { field: "credentialId", op: "eq", value: credentialId },
  ]);
  if (!passkey) return fail("passkey_unknown");
  if (userId !== null && passkey.userId !== userId) return fail("passkey_failed");
  let verified: Awaited<ReturnType<typeof config.webauthn.verifyAuthentication>>;
  try {
    verified = await config.webauthn.verifyAuthentication({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: fromBase64Url(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports ? passkey.transports.split(",") : null,
      },
    });
  } catch (e) {
    config.observe.emit({ name: "passkey.authentication_rejected", errorClass: e });
    return fail("passkey_failed");
  }
  const now = config.clock.now();
  // Conditional on the counter we read: two different assertions that read the same stored counter cannot both pass. A replay of one assertion is stopped earlier, by the challenge consume.
  const moved = await config.storage.update(
    "passkey",
    [
      { field: "id", op: "eq", value: passkey.id },
      { field: "counter", op: "eq", value: passkey.counter },
    ],
    { counter: verified.newCounter, backedUp: verified.backedUp, updatedAt: now },
  );
  if (moved !== 1) {
    config.observe.emit({ name: "passkey.counter_moved" });
    return fail("passkey_failed");
  }
  return ok(passkey);
}

export async function verifyPasskeyAuthentication(
  config: ResolvedConfig,
  input: {
    response: unknown;
    ip: string | null;
    userAgent: string | null;
    /**
     * The live anonymous session of the verify (plan 12i Task 7). The
     * assertion completes in this request, so the sign-in is bound: the
     * row's anonymous user links, or with none, this one.
     */
    anonymous?: AnonymousCaller | null | undefined;
  },
): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>> {
  if (!config.passkey) return fail("not_found");
  // First: no read, store, or log sees a PRF output or a large blob (plan 12i).
  const response = withoutSecretOutputs(input.response);
  if (!(await limit(config, "passkey-verify:ip", ipKey(input.ip), VERIFY_LIMIT))) {
    return fail("rate_limited");
  }
  const challenge = challengeFromResponse(response);
  if (!challenge) return fail("invalid_token");
  const consumed = await consumeChallenge(config, challenge, SIGN_IN, "authentication");
  if (!consumed.ok) return consumed;
  const checked = await checkAssertion(config, response, challenge, null);
  if (!checked.ok) return checked;
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: checked.value.userId },
  ]);
  if (!user) return fail("passkey_failed");
  // Only SSO signs in an address of an enforced domain (plan 12d): the assertion names the user.
  const enforced = await enforcedAnswer(config, user.email);
  if (enforced) return enforced;
  const upgrade = upgradeSteps(
    config,
    input.anonymous ?? null,
    recordedAnonymous(consumed.value.data),
    "bound",
  );
  // One transaction, so a session hook's membership check and the write read the same state.
  const opened = await hookGuard(async () =>
    ok(
      await config.storage.transaction(async (tx) => {
        // Before the session hook and its hold of the user row, as at the other pathways.
        await upgrade.before(tx, user, upgradeProof(user), "passkey");
        const prepared = await prepareSession(
          config,
          { user, ip: input.ip, userAgent: input.userAgent, via: "passkey" },
          tx,
        );
        await upgrade.claim(tx);
        return writeSession(config, prepared, tx);
      }),
    ),
  );
  if (!opened.ok) return opened;
  const { token, session } = opened.value;
  await sessionOpened(config, session, user, "passkey");
  await upgrade.after();
  return ok({ token, user, session });
}

/**
 * WebAuthn request options for a re-authentication (plan 12a): a challenge
 * row for the user id of kind `reauth`, with the user's passkeys in
 * `allowCredentials`. The per-IP limit of the sign-in options applies.
 */
export async function reauthPasskeyChallenge(
  config: ResolvedConfig,
  input: { user: UserRow; ip: string | null },
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  if (!config.passkey) return fail("not_found");
  if (!(await limit(config, "passkey-options:ip", ipKey(input.ip), OPTIONS_LIMIT)))
    return fail("rate_limited");
  const keys = await config.storage.findMany("passkey", [
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  const { bytes } = await issueChallenge(config, input.user.id, "reauth");
  return ok(
    await config.webauthn.authenticationOptions({
      rpID: config.passkey.rpID,
      challenge: bytes,
      allowCredentials: keys.map((p) => ({
        id: p.credentialId,
        transports: p.transports ? p.transports.split(",") : null,
      })),
    }),
  );
}

/**
 * The proof of a re-authentication by a passkey (plan 12a): an assertion
 * over the options of `reauthPasskeyChallenge` for this user, by a passkey of
 * this user. The challenge row is spent whatever comes next. The assertion
 * check and the counter rule are 12c's `checkAssertion`, one copy for every
 * ceremony. Core asks for user verification (spec 8.4), so a passkey is two
 * factors.
 */
export async function provePasskeyOf(
  config: ResolvedConfig,
  input: { userId: string; response: unknown },
): Promise<Result<true>> {
  if (!config.passkey) return fail("not_found");
  const response = withoutSecretOutputs(input.response);
  const challenge = challengeFromResponse(response);
  if (!challenge) return fail("invalid_token");
  const consumed = await consumeChallenge(config, challenge, input.userId, "reauth");
  if (!consumed.ok) return consumed;
  const checked = await checkAssertion(config, response, challenge, input.userId);
  return checked.ok ? ok(true) : fail("passkey_failed");
}

/**
 * WebAuthn request options for the second factor of one challenge (plan
 * 12c): the user's passkeys in `allowCredentials`, user verification
 * required, and a challenge row bound to the `tf_` challenge's row id.
 */
export async function secondFactorPasskeyOptions(
  config: ResolvedConfig,
  input: { userId: string; challengeId: string },
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  if (!config.passkey) return fail("not_found");
  const keys = await config.storage.findMany("passkey", [
    { field: "userId", op: "eq", value: input.userId },
  ]);
  const { bytes } = await issueChallenge(config, input.userId, "second-factor", {
    challengeId: input.challengeId,
  });
  return ok(
    await config.webauthn.authenticationOptions({
      rpID: config.passkey.rpID,
      challenge: bytes,
      allowCredentials: keys.map((p) => ({
        id: p.credentialId,
        transports: p.transports ? p.transports.split(",") : null,
      })),
    }),
  );
}

/**
 * True for an assertion over the options of `secondFactorPasskeyOptions` for
 * this challenge, by a passkey of this user (plan 12c). The passkey row of
 * the ceremony is spent whatever comes next.
 */
export async function checkSecondFactorPasskey(
  config: ResolvedConfig,
  input: { userId: string; challengeId: string; response: unknown },
): Promise<boolean> {
  const response = withoutSecretOutputs(input.response);
  const challenge = challengeFromResponse(response);
  if (!challenge) return false;
  const consumed = await consumeChallenge(
    config,
    challenge,
    input.userId,
    "second-factor",
    input.challengeId,
  );
  if (!consumed.ok) return false;
  return (await checkAssertion(config, response, challenge, input.userId)).ok;
}

/**
 * True for a sign-in assertion (the options of `POST /passkey/authenticate/options`)
 * by a passkey of this user (plan 12c): the enable's proof that the person
 * holds a passkey now. The sign-in challenge row is spent.
 */
export async function checkSignInAssertionOf(
  config: ResolvedConfig,
  input: { userId: string; response: unknown },
): Promise<boolean> {
  const response = withoutSecretOutputs(input.response);
  const challenge = challengeFromResponse(response);
  if (!challenge) return false;
  const consumed = await consumeChallenge(config, challenge, SIGN_IN, "authentication");
  if (!consumed.ok) return false;
  return (await checkAssertion(config, response, challenge, input.userId)).ok;
}

/**
 * The inputs of the Signal API for the user (WebAuthn Level 3, plan 12i):
 * the RP ID and the base64url user handle for
 * `signalAllAcceptedCredentials`, and the names of the registration
 * options for `signalCurrentUserDetails` (plan 12i Task 15). The names
 * come from the one rule of the options, so the browser shows what a new
 * registration would show.
 */
export function signalInputs(
  config: ResolvedConfig,
  user: UserRow,
): Result<{ rpId: string; userHandle: string; userName: string; userDisplayName: string }> {
  if (!config.passkey) return fail("not_found");
  const userName = passkeyUserName(config, user);
  return ok({
    rpId: config.passkey.rpID,
    userHandle: toBase64Url(userHandleOf(user.id)),
    userName,
    userDisplayName: user.name ?? userName,
  });
}

export async function listPasskeys(
  config: ResolvedConfig,
  input: { user: UserRow },
): Promise<Result<PasskeySummary[]>> {
  if (!config.passkey) return fail("not_found");
  const rows = await config.storage.findMany(
    "passkey",
    [{ field: "userId", op: "eq", value: input.user.id }],
    { sort: { field: "id", dir: "asc" } },
  );
  return ok(rows.map(summary));
}

/**
 * Renames one passkey of the user (plan 12a Task 19). A name is no way in, so
 * the rename needs a session and no fresh session. The order: the feature,
 * the name rule, the limit count, then one conditional update by the id and
 * the user id. A refused name counts no try.
 *
 * The id of another user's passkey and an unknown id answer `not_found` by
 * the same calls: the count and one update that matches no row. So the
 * answer and its time tell nothing of another user's passkeys. The read
 * after the update gives the stored row; a parallel rename can win it.
 */
export async function renamePasskey(
  config: ResolvedConfig,
  input: { user: UserRow; id: string; name: string },
): Promise<Result<{ passkey: PasskeySummary }>> {
  if (!config.passkey) return fail("not_found");
  if (!validPasskeyName(input.name)) return fail("invalid_body");
  if (!(await limit(config, "passkey-rename:user", input.user.id, RENAME_PER_USER)))
    return fail("rate_limited");
  const own: Where<"passkey">[] = [
    { field: "id", op: "eq", value: input.id },
    { field: "userId", op: "eq", value: input.user.id },
  ];
  const now = config.clock.now();
  const renamed = await config.storage.update("passkey", own, {
    name: input.name,
    updatedAt: now,
  });
  if (renamed !== 1) return fail("not_found");
  // A parallel delete between the two statements leaves no row.
  const row = await config.storage.findOne("passkey", own);
  return row ? ok({ passkey: summary(row) }) : fail("not_found");
}

/** Thrown inside the delete's transaction when it took the last passkey of the passkey method. The throw undoes the delete. */
class LastMethodError extends Error {
  constructor() {
    super("authtempo: the last passkey of the passkey method");
    this.name = "LastMethodError";
  }
}

/**
 * Deletes one passkey of the user, under the last-credential guard (plan
 * 12a): a user keeps at least one way in, else `last_credential`. While
 * `passkey` is a second-factor method, the last passkey stays:
 * `second_factor_last_method` (plan 12c). The person turns the method off
 * first, or registers another passkey.
 *
 * The locks, on Postgres READ COMMITTED. The guard first holds the user row
 * (`guardedRemove`), as every removal of a way in does. With a factor row,
 * the delete then writes its `updatedAt` by a compare-and-set, which holds
 * the factor row. A parallel enable or disable that wrote it first answers
 * `conflict`. The delete statement holds the passkey row; it waits for a
 * parallel `enableMethod`, which holds every passkey row of the user. After
 * the delete, the factor row and the passkeys left are read again. These
 * reads see a factor row that a parallel first enable committed, which the
 * first read could not see. With the method on and no passkey left, the
 * throw undoes the delete.
 */
export async function deletePasskey(
  config: ResolvedConfig,
  input: { user: UserRow; id: string },
): Promise<Result<{ ok: true }>> {
  if (!config.passkey) return fail("not_found");
  const now = config.clock.now();
  let removed: Result<UserRow>;
  try {
    removed = await guardedRemove(config, input.user.id, async (tx) => {
      const factor = await factorRow(tx, input.user.id);
      // A second guard. The user lock now orders two deletes, and the reads
      // after the delete see a parallel first enable. The hold still stops a
      // parallel enable or disable that wrote the factor row first. No
      // Postgres test fails without it (review L1, break O7, 2026-10-17).
      if (factor) {
        const held = await tx.update(
          "secondFactor",
          [
            { field: "id", op: "eq", value: factor.id },
            { field: "updatedAt", op: "eq", value: factor.updatedAt },
          ],
          { updatedAt: later(now, factor.updatedAt) },
        );
        if (held === 0) throw new FactorRaceError();
      }
      const deleted = await tx.delete("passkey", [
        { field: "id", op: "eq", value: input.id },
        { field: "userId", op: "eq", value: input.user.id },
      ]);
      // Zero rows: the guard answers not_found and undoes the holds.
      if (deleted !== 1) return deleted;
      const after = await factorRow(tx, input.user.id);
      if (after?.methods.includes("passkey")) {
        const left = await tx.findMany("passkey", [
          { field: "userId", op: "eq", value: input.user.id },
        ]);
        if (left.length === 0) throw new LastMethodError();
      }
      return deleted;
    });
  } catch (err) {
    if (err instanceof LastMethodError) return fail("second_factor_last_method");
    // A parallel enable or disable wrote the factor row first. The person retries.
    if (err instanceof FactorRaceError) return fail("conflict");
    throw err;
  }
  if (!removed.ok) return removed;
  config.observe.emit({ name: "passkey.delete", outcome: "success", userId: input.user.id });
  // After the commit (plan 12a). A refused delete sends no notice. The
  // address is the one of the row that the guard held.
  await sendNotice(config, {
    event: "passkey_removed",
    email: removed.value.email,
    ip: null,
    userAgent: null,
  });
  return ok({ ok: true });
}
