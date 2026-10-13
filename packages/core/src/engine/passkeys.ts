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
import { openSession, sessionOpened } from "./sessions.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const SIGN_IN = "sign-in";
const OPTIONS_LIMIT = { seconds: 15 * 60, max: 30 };
const VERIFY_LIMIT = { seconds: 15 * 60, max: 20 };

type Kind = "registration" | "authentication";

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

/** Writes the challenge row and returns the challenge bytes and their base64url form. */
async function issueChallenge(
  config: ResolvedConfig,
  identifier: string,
  kind: Kind,
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
    data: { kind },
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
  const data = row.data as { kind?: unknown } | null;
  if (row.identifier !== identifier || data?.kind !== kind) return fail("invalid_token");
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
  const credentialId = (input.response as { id?: unknown }).id;
  if (typeof credentialId !== "string") return fail("passkey_failed");
  const passkey = await config.storage.findOne("passkey", [
    { field: "credentialId", op: "eq", value: credentialId },
  ]);
  // An unknown credential and a bad signature answer the same code.
  if (!passkey) return fail("passkey_failed");
  let verified: Awaited<ReturnType<typeof config.webauthn.verifyAuthentication>>;
  try {
    verified = await config.webauthn.verifyAuthentication({
      response: input.response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.passkey.origins,
      expectedRPID: config.passkey.rpID,
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
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: passkey.userId },
  ]);
  if (!user) return fail("passkey_failed");
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

export async function deletePasskey(
  config: ResolvedConfig,
  input: { user: UserRow; id: string },
): Promise<Result<{ ok: true }>> {
  if (!config.passkey) return fail("not_found");
  const deleted = await config.storage.delete("passkey", [
    { field: "id", op: "eq", value: input.id },
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  return deleted === 1 ? ok({ ok: true }) : fail("not_found");
}
