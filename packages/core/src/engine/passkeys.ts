import type { ResolvedConfig } from "../config.js";
import { fromBase64Url, randomBase64Url, sha256Hex, toBase64Url } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { PasskeyRow, SessionRow, UserRow } from "../schema.js";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "../seams/webauthn.js";
import { StorageError } from "../storage/port.js";
import { hookGuard } from "./hooks.js";
import { FactorRaceError, factorRow, later } from "./second-factor.js";
import { openSession, sessionOpened } from "./sessions.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const SIGN_IN = "sign-in";
const OPTIONS_LIMIT = { seconds: 15 * 60, max: 30 };
const VERIFY_LIMIT = { seconds: 15 * 60, max: 20 };

/** `second-factor`: a ceremony bound to one `tf_` challenge (plan 12c). */
type Kind = "registration" | "authentication" | "second-factor";

export interface PasskeySummary {
  id: string;
  credentialId: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
}

function summary(row: PasskeyRow): PasskeySummary {
  return {
    id: row.id,
    credentialId: row.credentialId,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt,
  };
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
): Promise<Result<true>> {
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
  return ok(true);
}

export async function passkeyRegistrationOptions(
  config: ResolvedConfig,
  input: { user: UserRow },
): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> {
  if (!config.passkey) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const existing = await config.storage.findMany("passkey", [
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  const { bytes } = await issueChallenge(config, input.user.id, "registration");
  const options = await config.webauthn.registrationOptions({
    rpID: config.passkey.rpID,
    rpName: config.passkey.rpName,
    userID: new TextEncoder().encode(input.user.id),
    userName: input.user.email,
    userDisplayName: input.user.name ?? input.user.email,
    challenge: bytes,
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: p.transports ? p.transports.split(",") : null,
    })),
  });
  return ok(options);
}

export async function verifyPasskeyRegistration(
  config: ResolvedConfig,
  input: { user: UserRow; response: unknown; name?: string | undefined },
): Promise<Result<PasskeySummary>> {
  if (!config.passkey) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const challenge = challengeFromResponse(input.response);
  if (!challenge) return fail("invalid_token");
  const consumed = await consumeChallenge(config, challenge, input.user.id, "registration");
  if (!consumed.ok) return consumed;
  let registered: Awaited<ReturnType<typeof config.webauthn.verifyRegistration>>;
  try {
    registered = await config.webauthn.verifyRegistration({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.passkey.origins,
      expectedRPID: config.passkey.rpID,
    });
  } catch (e) {
    console.error(
      "authtempo: passkey registration rejected",
      e instanceof Error ? e.name : typeof e,
    );
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
      name: input.name ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    // The credential id is unique across users. A second registration of
    // the same authenticator answers like any other failed ceremony.
    if (e instanceof StorageError && e.code === "unique_violation" && e.model === "passkey") {
      console.error("authtempo: passkey credential already registered");
      return fail("passkey_failed");
    }
    throw e;
  }
  return ok(summary(row));
}

export async function passkeyAuthenticationOptions(
  config: ResolvedConfig,
  input: { ip: string | null },
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  if (!config.passkey) return fail("not_found");
  if (!(await config.limiter.allow(`passkey-options:ip:${input.ip ?? "unknown"}`, OPTIONS_LIMIT))) {
    return fail("rate_limited");
  }
  const { bytes } = await issueChallenge(config, SIGN_IN, "authentication");
  return ok(
    await config.webauthn.authenticationOptions({ rpID: config.passkey.rpID, challenge: bytes }),
  );
}

/**
 * The assertion check of a sign-in and of the second factor (plan 12c): the
 * credential, the seam, and the counter compare-and-set. With `userId`, the
 * credential must be one of that user's passkeys. An unknown credential, a
 * credential of another user, and a bad signature answer the same code. The
 * caller has consumed the challenge row first.
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
  if (!passkey || (userId !== null && passkey.userId !== userId)) return fail("passkey_failed");
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
    console.error(
      "authtempo: passkey authentication rejected",
      e instanceof Error ? e.name : typeof e,
    );
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
    console.error("authtempo: passkey counter moved");
    return fail("passkey_failed");
  }
  return ok(passkey);
}

export async function verifyPasskeyAuthentication(
  config: ResolvedConfig,
  input: { response: unknown; ip: string | null; userAgent: string | null },
): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>> {
  if (!config.passkey) return fail("not_found");
  if (!(await config.limiter.allow(`passkey-verify:ip:${input.ip ?? "unknown"}`, VERIFY_LIMIT))) {
    return fail("rate_limited");
  }
  const challenge = challengeFromResponse(input.response);
  if (!challenge) return fail("invalid_token");
  const consumed = await consumeChallenge(config, challenge, SIGN_IN, "authentication");
  if (!consumed.ok) return consumed;
  const checked = await checkAssertion(config, input.response, challenge, null);
  if (!checked.ok) return checked;
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: checked.value.userId },
  ]);
  if (!user) return fail("passkey_failed");
  // One transaction, so a session hook's membership check and the write read the same state.
  const opened = await hookGuard(async () =>
    ok(
      await config.storage.transaction((tx) =>
        openSession(config, { user, ip: input.ip, userAgent: input.userAgent, via: "passkey" }, tx),
      ),
    ),
  );
  if (!opened.ok) return opened;
  const { token, session } = opened.value;
  await sessionOpened(config, session, user, "passkey");
  return ok({ token, user, session });
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
  const challenge = challengeFromResponse(input.response);
  if (!challenge) return false;
  const consumed = await consumeChallenge(
    config,
    challenge,
    input.userId,
    "second-factor",
    input.challengeId,
  );
  if (!consumed.ok) return false;
  return (await checkAssertion(config, input.response, challenge, input.userId)).ok;
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
  const challenge = challengeFromResponse(input.response);
  if (!challenge) return false;
  const consumed = await consumeChallenge(config, challenge, SIGN_IN, "authentication");
  if (!consumed.ok) return false;
  return (await checkAssertion(config, input.response, challenge, input.userId)).ok;
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

/** Thrown inside the delete's transaction when it took the last passkey of the passkey method. The throw undoes the delete. */
class LastMethodError extends Error {
  constructor() {
    super("authtempo: the last passkey of the passkey method");
    this.name = "LastMethodError";
  }
}

/**
 * Deletes one passkey of the user. While `passkey` is a second-factor method,
 * the last passkey stays: `second_factor_last_method` (plan 12c). The person
 * turns the method off first, or registers another passkey.
 *
 * The locks, on Postgres READ COMMITTED. With a factor row, the delete first
 * writes its `updatedAt` by a compare-and-set, which holds the factor row: of
 * two parallel deletes, the second waits for the first commit, and its
 * compare then matches no row (`conflict`). The delete statement holds the
 * passkey row; it waits for a parallel `enableMethod`, which holds every
 * passkey row of the user. After the delete, the factor row and the passkeys
 * left are read again. These reads see a factor row that a parallel first
 * enable committed, which the first read could not see. With the method on
 * and no passkey left, the throw undoes the delete.
 */
export async function deletePasskey(
  config: ResolvedConfig,
  input: { user: UserRow; id: string },
): Promise<Result<{ ok: true }>> {
  if (!config.passkey) return fail("not_found");
  const now = config.clock.now();
  try {
    return await config.storage.transaction(async (tx): Promise<Result<{ ok: true }>> => {
      const factor = await factorRow(tx, input.user.id);
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
      if (deleted !== 1) return fail("not_found");
      const after = await factorRow(tx, input.user.id);
      if (after?.methods.includes("passkey")) {
        const left = await tx.findMany("passkey", [
          { field: "userId", op: "eq", value: input.user.id },
        ]);
        if (left.length === 0) throw new LastMethodError();
      }
      return ok({ ok: true });
    });
  } catch (err) {
    if (err instanceof LastMethodError) return fail("second_factor_last_method");
    // A parallel delete, enable, or disable wrote the row first. The person retries.
    if (err instanceof FactorRaceError) return fail("conflict");
    throw err;
  }
}
