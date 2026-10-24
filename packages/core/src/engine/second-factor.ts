import type { ResolvedConfig, ResolvedTotp } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import type { Observer } from "../observe/observer.js";
import { constantTimeEqual, hmacSha256Hex, randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { currentSecret, hashSecretFor } from "../primitives/keyring.js";
import { groupBackupCode, normalizeBackupCode, randomBackupCode } from "../primitives/totp.js";
import { fail, ok, type Result } from "../result.js";
import type { SecondFactorMethod, SecondFactorRow, SessionRow, UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import { stopWith } from "./hooks.js";
import type { LastMethod } from "./last-method.js";
import type { ImpersonationStops } from "./operator/audit.js";
import { activeBan } from "./operator/ban-rule.js";
import { ROUNDS } from "./rounds.js";
import { endSessions, type PreparedSession, prepareSession, writeSession } from "./sessions.js";
import { type OpenedStateData, sealStateData } from "./state-data.js";
import { holdUser } from "./user-hold.js";

/**
 * The second factor apart from its methods (plan 12c, spec 8.11 and 8.14).
 * One `secondFactor` row per user holds the methods that are on and the
 * backup codes. The row exists only while a method is on, so "the factor is
 * on" is "the row exists", and every gate reads this row. The TOTP method
 * keeps its sealed secret in `totp` (engine/totp.ts).
 */

/** The version of a new backup code list: codes of 112 bits or more (ASVS 5.0 6.5.2). */
export const BACKUP_CODES_VERSION = 2;
// The bound of a compare-and-set loop. One copy, in rounds.ts; the old
// importers read it here.
export { ROUNDS };

// Per 15 minutes, for the password check of the TOTP setup and of every
// method's enable and disable (plan 9h, owner decision 3a; plan 12c). Its own
// key, not the sign-in's `password:ip` and `password:email`: a stolen session
// that guesses here must not hold the owner's password sign-in at
// rate_limited. 5 is half the sign-in's per-address budget.
export const SETUP_PER_USER = { seconds: 900, max: 5 };

/** A write time strictly after `than`, so a compare-and-set on `updatedAt` sees every write. */
export function later(now: Date, than: Date): Date {
  return new Date(Math.max(now.getTime(), than.getTime() + 1));
}

/** The factor row of the user, or null when the factor is off. */
export function factorRow(
  storage: StorageAdapter,
  userId: string,
): Promise<SecondFactorRow | null> {
  return storage.findOne("secondFactor", [{ field: "userId", op: "eq", value: userId }]);
}

/** HMAC-SHA256 hex under the app secret of `<row id>:<code>` (spec 8.11 item 3). */
function backupCodeHash(secret: string, rowId: string, code: string): Promise<string> {
  return hmacSha256Hex(secret, `${rowId}:${code}`);
}

/**
 * New backup codes for the row `rowId`: the codes to show once, in groups,
 * and their keyed hashes. The hash is of the code with no dash, as
 * `normalizeBackupCode` reads a typed code.
 */
export async function newBackupCodes(
  config: ResolvedConfig,
  totp: ResolvedTotp,
  rowId: string,
): Promise<{ codes: string[]; hashes: string[] }> {
  const raw = Array.from({ length: totp.backupCodes }, () =>
    randomBackupCode(totp.backupCodeLength),
  );
  const hashes = await Promise.all(
    raw.map((c) => backupCodeHash(currentSecret(config.keyring), rowId, c)),
  );
  return { codes: raw.map(groupBackupCode), hashes };
}

/**
 * Spends a backup code: the codes left, or null for a code that is not
 * there. Every stored hash runs the compare. The removal is a compare-and-set
 * on `updatedAt`, so two parallel uses of one code spend it once: the loser
 * reads the row again and no longer finds the code. A list of version 1
 * passes too: the hash does not depend on the length.
 */
export async function spendBackupCode(
  config: ResolvedConfig,
  row: SecondFactorRow,
  code: string,
  now: Date,
): Promise<number | null> {
  const typed = normalizeBackupCode(code);
  let current: SecondFactorRow | null = row;
  // A hard bound, as `countAttempt` has. Each lost round means that a
  // parallel use spent a code, so an honest adapter ends before the list is
  // empty. Without the bound one backup code holds a request forever on an
  // adapter whose `eq` on a date never matches.
  for (let round = 0; round <= row.backupCodes.length; round++) {
    if (!current) return null;
    // The row's version keys the compare (plan 12b). A spend writes the
    // codes only: the codes left keep the version that keyed them.
    const key = hashSecretFor(config.observe, config.keyring, current.secretVersion, current.id);
    const candidate = await backupCodeHash(key.secret, current.id, typed);
    let found = -1;
    current.backupCodes.forEach((hash, i) => {
      if (constantTimeEqual(candidate, hash)) found = i;
    });
    // Every stored hash ran the compare; an unknown version matches nothing.
    if (found === -1 || !key.known) return null;
    const left = current.backupCodes.filter((_, i) => i !== found);
    const n = await config.storage.update(
      "secondFactor",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      { backupCodes: left, updatedAt: later(now, current.updatedAt) },
    );
    if (n === 1) return left.length;
    current = await config.storage.findOne("secondFactor", [
      { field: "id", op: "eq", value: current.id },
    ]);
  }
  config.observe.emit({ name: "backup_code.spend_gave_up", rowId: row.id });
  return null;
}

/**
 * A new list of backup codes at version 2, by a compare-and-set on
 * `updatedAt`: a backup code spent at the same time does not come back.
 */
export async function replaceBackupCodes(
  config: ResolvedConfig,
  totp: ResolvedTotp,
  row: SecondFactorRow,
  now: Date,
): Promise<Result<{ backupCodes: string[] }>> {
  let current: SecondFactorRow | null = row;
  // A lost round means that a parallel spend or replacement wrote first.
  // Past the bound the answer is `conflict`, because the factor is still on.
  for (let round = 0; round < ROUNDS; round++) {
    if (!current) return fail("totp_not_enabled");
    const { codes, hashes } = await newBackupCodes(config, totp, current.id);
    const n = await config.storage.update(
      "secondFactor",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      {
        backupCodes: hashes,
        backupCodesVersion: BACKUP_CODES_VERSION,
        updatedAt: later(now, current.updatedAt),
        // `newBackupCodes` keyed the new list under the current version (plan 12b).
        secretVersion: config.keyring.current,
      },
    );
    if (n === 1) return ok({ backupCodes: codes });
    current = await config.storage.findOne("secondFactor", [
      { field: "id", op: "eq", value: current.id },
    ]);
  }
  config.observe.emit({ name: "backup_code.replace_gave_up", rowId: row.id });
  return fail("conflict");
}

/**
 * A challenge is a session in waiting, as a handoff code is. So a flow that
 * ends the user's sessions or changes the factor deletes the user's challenges.
 */
export async function deleteTwoFactorChallenges(tx: StorageAdapter, userId: string): Promise<void> {
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "two-factor" },
    { field: "identifier", op: "eq", value: userId },
  ]);
}

/**
 * Thrown inside a transaction when the compare-and-set on the factor row lost
 * every round, or the row went under the write. The throw undoes the
 * transaction; the caller answers `conflict` outside it, and the person retries.
 */
export class FactorRaceError extends Error {
  constructor() {
    super("authtempo: the second factor row changed under the write");
    this.name = "FactorRaceError";
  }
}

/**
 * Thrown inside a transaction when the first method has no backup codes: a
 * TOTP setup made while another method was on, and that method went off
 * before the enable (plan 12c). The throw undoes the transaction; the caller
 * answers `totp_not_enabled`, and the person runs the setup again.
 */
export class NoBackupCodesError extends Error {
  constructor() {
    super("authtempo: the first method has no backup codes");
    this.name = "NoBackupCodesError";
  }
}

export interface AddedMethod {
  /** True when this call wrote the row: the first method. */
  first: boolean;
  /** False when the method was on already and nothing was written (plan 12a: no notice then). */
  changed: boolean;
  row: SecondFactorRow;
  /** The count of the other sessions that the first method ended (plan 12h Task 5). */
  ended: number;
}

/**
 * Turns `method` on, inside the caller's transaction (spec 8.11 item 1, 8.14).
 * With no row, it writes the row with `first`: the id and the backup code
 * hashes that the caller made under that id. Then every other session of the
 * user ends, and the trusted devices and the challenges go: the enable of the
 * first method, so a session a thief holds does not survive it. The caller
 * fires `two_factor` for `ended` after its commit. With a row, it adds the
 * method by a compare-and-set on `updatedAt` and ends nothing. A method that
 * is on already changes nothing. A parallel first enable of another method
 * fails this create on the unique `userId`; the caller catches it outside.
 */
export async function addMethod(
  tx: StorageAdapter,
  input: {
    userId: string;
    keepSessionId: string;
    method: SecondFactorMethod;
    /**
     * The id and the backup codes of a new factor row, and the secret
     * version that keyed the codes (plan 12b).
     */
    first: { id: string; backupCodes: string[]; secretVersion: number };
  },
  now: Date,
  ended: SessionRow[] | undefined,
  stops: ImpersonationStops | null,
): Promise<AddedMethod> {
  let current = await factorRow(tx, input.userId);
  if (!current) {
    // A factor with no backup codes has no last resort. The row is never
    // written so.
    if (input.first.backupCodes.length === 0) throw new NoBackupCodesError();
    const row = await tx.create("secondFactor", {
      id: input.first.id,
      userId: input.userId,
      enabledAt: now,
      methods: [input.method],
      backupCodes: input.first.backupCodes,
      backupCodesVersion: BACKUP_CODES_VERSION,
      createdAt: now,
      updatedAt: now,
      secretVersion: input.first.secretVersion,
    });
    const n = await endSessions(
      tx,
      [
        { field: "userId", op: "eq", value: input.userId },
        { field: "id", op: "ne", value: input.keepSessionId },
      ],
      ended ?? null,
      now,
      stops,
    );
    await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: input.userId }]);
    await deleteTwoFactorChallenges(tx, input.userId);
    return { first: true, changed: true, row, ended: n };
  }
  for (let round = 0; round < ROUNDS; round++) {
    // A parallel disable of the last method deleted the row: the person retries.
    if (!current) throw new FactorRaceError();
    if (current.methods.includes(input.method))
      return { first: false, changed: false, row: current, ended: 0 };
    const methods = [...current.methods, input.method];
    const updatedAt = later(now, current.updatedAt);
    const n = await tx.update(
      "secondFactor",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      { methods, updatedAt },
    );
    if (n === 1)
      return { first: false, changed: true, row: { ...current, methods, updatedAt }, ended: 0 };
    current = await factorRow(tx, input.userId);
  }
  throw new FactorRaceError();
}

/**
 * Turns `method` off, inside the caller's transaction. The last method
 * deletes the row, the trusted devices, and the challenges: the factor is off
 * (spec 8.11 item 1). Both writes are a compare-and-set on `updatedAt`, so a
 * parallel enable or disable has one winner. False when the method was not on.
 */
export async function removeMethod(
  tx: StorageAdapter,
  userId: string,
  method: SecondFactorMethod,
  now: Date,
): Promise<boolean> {
  let current = await factorRow(tx, userId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!current?.methods.includes(method)) return false;
    const methods = current.methods.filter((m) => m !== method);
    const where = [
      { field: "id" as const, op: "eq" as const, value: current.id },
      { field: "updatedAt" as const, op: "eq" as const, value: current.updatedAt },
    ];
    if (methods.length === 0) {
      if ((await tx.delete("secondFactor", where)) === 1) {
        await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: userId }]);
        await deleteTwoFactorChallenges(tx, userId);
        return true;
      }
    } else if (
      (await tx.update("secondFactor", where, {
        methods,
        updatedAt: later(now, current.updatedAt),
      })) === 1
    )
      return true;
    current = await factorRow(tx, userId);
  }
  throw new FactorRaceError();
}

/**
 * Turns the whole factor off, every method, in one transaction: the `totp`
 * row, the factor row, the trusted devices, and the challenges. For the
 * operator after identity proofing at the level of the enrollment (ASVS 5.0
 * 6.4.4), and for an app that checked the person another way. Answers the
 * count of factor rows it deleted.
 */
export function disableSecondFactor(config: ResolvedConfig, userId: string): Promise<number> {
  return config.storage.transaction((tx) => disableSecondFactorIn(config.observe, tx, userId));
}

/**
 * The deletes of `disableSecondFactor` in the caller's transaction (plan
 * 12f deviation 7). The operator's disable runs them beside its audit row.
 * The hold of the user row comes first, so every caller keeps the lock
 * order of user-hold.ts. The account delete deletes the trusted devices
 * before the factor row, so without the hold Postgres finds a deadlock
 * (plan 12f Task 9 review m1). The hold is one read and one update, then
 * four delete statements; the answer is the count of factor rows deleted.
 */
export async function disableSecondFactorIn(
  observe: Observer,
  tx: StorageAdapter,
  userId: string,
): Promise<number> {
  await holdUser(observe, tx, userId);
  await tx.delete("totp", [{ field: "userId", op: "eq", value: userId }]);
  const n = await tx.delete("secondFactor", [{ field: "userId", op: "eq", value: userId }]);
  await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: userId }]);
  await deleteTwoFactorChallenges(tx, userId);
  return n;
}

export const TWO_FACTOR_PREFIX = "tf_";
export const TWO_FACTOR_TOKEN_RE = /^tf_[A-Za-z0-9_-]{43}$/;
export const TRUST_PREFIX = "td_";
export const TRUST_TOKEN_RE = /^td_[A-Za-z0-9_-]{43}$/;
/**
 * A challenge lives 5 minutes (spec 8.11). An email code of the challenge
 * lives with it, below the 10 minutes of ASVS 5.0 6.5.5 for an out-of-band code.
 */
export const CHALLENGE_TTL_MS = 300_000;

/** A method that a challenge offers: a method of the row, or a backup code. */
export type ChallengeMethod = SecondFactorMethod | "backup";

/**
 * The order of preference (spec 8.14): a passkey resists phishing, a TOTP
 * code needs no mail, an email code needs a mail, and a backup code is the
 * last resort. The challenge page shows the first method it can serve.
 */
const PREFERENCE: readonly ChallengeMethod[] = ["passkey", "totp", "email", "backup"];

/**
 * The first factors that a challenge can follow (plan 12c; `sso` since plan
 * 12d; `phone` since plan 12i). Each is a `SessionVia`.
 */
export type GatedVia = "password" | "magic_link" | "email_otp" | "social" | "sso" | "phone";
const GATED_VIA: ReadonlySet<string> = new Set([
  "password",
  "magic_link",
  "email_otp",
  "social",
  "sso",
  "phone",
]);

/** How the person proved the first factor: the session's `via`, and `reset` for a password reset. */
export interface ChallengeOrigin {
  via: GatedVia;
  from: "sign-in" | "reset";
}

/** The answer of a flow whose user has the factor on: no session yet (plan 9f; `methods` since plan 12c). */
export interface TwoFactorPending {
  twoFactor: { challenge: string; expiresAt: Date; methods: ChallengeMethod[] };
}

/**
 * The origin that a challenge row holds. A row of plan 9f holds
 * `via: "password"` and no `from`, so it reads as a password sign-in. An
 * unknown `via` reads as `magic_link`, the narrowest list. Only the engine
 * writes the row, so an unknown `via` is a damaged row, and it gets no
 * email method.
 */
export function challengeOrigin(data: unknown): ChallengeOrigin {
  const d = data as { via?: unknown; from?: unknown } | null;
  const via =
    typeof d?.via === "string" && GATED_VIA.has(d.via) ? (d.via as GatedVia) : "magic_link";
  return { via, from: d?.from === "reset" ? "reset" : "sign-in" };
}

/**
 * The methods that pass for a challenge, in the order of preference. The
 * verify reads the list again from the current row, so a method that goes
 * off after the challenge no longer passes.
 */
export function challengeMethods(
  config: ResolvedConfig,
  row: SecondFactorRow,
  origin: ChallengeOrigin,
): ChallengeMethod[] {
  const on = new Set<ChallengeMethod>(row.methods);
  // An email code proves the mailbox. It counts as the second factor after a
  // password sign-in only (owner decision 4 of 2026-10-14): a reset, a magic
  // link, and an email code sign-in prove the mailbox already, and a social
  // provider account often holds the mailbox.
  if (origin.via !== "password" || origin.from !== "sign-in") on.delete("email");
  // A passkey ceremony needs the passkey config: the relying party and its origins.
  if (!config.passkey) on.delete("passkey");
  if (row.backupCodes.length > 0) on.add("backup");
  return PREFERENCE.filter((m) => on.has(m));
}

export interface ChallengeInput extends ChallengeOrigin {
  userId: string;
  /** The ban fields of the row the flow read (ruling 14 of plan 12f): no new read. */
  user: Pick<UserRow, "bannedAt" | "banUntil">;
  ip: string | null;
  userAgent: string | null;
  next: string | undefined;
  /** The latest expiry of the session that the verify opens (plan 12d): a SAML `SessionNotOnOrAfter`. */
  notAfter?: Date | undefined;
  /** The app payload of a social sign-in (plan 12i Task 19), sealed into the row for the verify. */
  stateData?: OpenedStateData;
  /** The last method of the sign-in (plan 12i Task 12): the verify sets its cookie. A reset has none. */
  method?: LastMethod;
}

/**
 * Writes a challenge in place of a session on `storage`, the flow's
 * transaction, and answers it with its methods. The row is a `two-factor`
 * verification row (spec 8.11 item 4). Its `data` holds the origin, so the
 * verify opens the session with the same `via`, and the IP, the user agent,
 * and `next` of the first factor.
 *
 * An active ban stops it with `account_banned` before the insert (plan 12f
 * deviation 12). So a banned user gets no challenge and no mailed code.
 */
export async function writeChallenge(
  config: ResolvedConfig,
  storage: StorageAdapter,
  row: SecondFactorRow,
  input: ChallengeInput,
  now: Date,
): Promise<{ id: string; pending: TwoFactorPending }> {
  if (activeBan(input.user, now)) stopWith("account_banned");
  const challenge = randomToken(TWO_FACTOR_PREFIX);
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const id = newId(now);
  // Sealed under this row's id, with its version in `data`: the email code
  // send moves the row's `secretVersion` to the current one (plan 12i Task 19).
  const payload = input.stateData ? await sealStateData(config, input.stateData.plain, id) : null;
  await storage.create("verification", {
    id,
    purpose: "two-factor",
    identifier: input.userId,
    valueHash: await sha256Hex(challenge),
    expiresAt,
    consumedAt: null,
    data: {
      via: input.via,
      from: input.from,
      ip: input.ip,
      userAgent: input.userAgent,
      next: safeNext(input.next),
      attempts: 0,
      ...(input.notAfter ? { notAfter: input.notAfter.toISOString() } : {}),
      ...(payload ? { sealedData: payload.sealed, sealedDataVersion: payload.version } : {}),
      ...(input.method ? { method: input.method } : {}),
    },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  return {
    id,
    pending: { twoFactor: { challenge, expiresAt, methods: challengeMethods(config, row, input) } },
  };
}

/** The gate's reads: no gate, maybe with a trust row to touch after the commit, or the factor row. */
export type GateRead =
  | { gated: false; trustId: string | null }
  | { gated: true; row: SecondFactorRow };

/**
 * The id of a live trust row of this user for the clear `td_` token, or null.
 * A row of another user and an expired row are no trust. A read only: the
 * sweep deletes an expired row (`SweepResult.trustedDevices`).
 */
export async function liveTrust(
  storage: StorageAdapter,
  userId: string,
  token: string | undefined,
  now: Date,
): Promise<string | null> {
  if (token === undefined || !TRUST_TOKEN_RE.test(token)) return null;
  const t = await storage.findOne("trustedDevice", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  return t && t.userId === userId && t.expiresAt.getTime() > now.getTime() ? t.id : null;
}

/**
 * The gate's reads, with no write (plan 12c): the factor row and a live trust
 * row of the same user, on `storage`. The reset and the gated sign-ins read
 * here inside their transaction, before the session hook, which runs before
 * the first write (plan 9d). They write `lastSeenAt` after the commit with
 * `touchTrust`. No `totp` config: no gate.
 */
export async function gateRead(
  config: ResolvedConfig,
  storage: StorageAdapter,
  userId: string,
  trustToken: string | undefined,
  now: Date,
): Promise<GateRead> {
  if (!config.totp) return { gated: false, trustId: null };
  const row = await factorRow(storage, userId);
  if (!row) return { gated: false, trustId: null };
  const trustId = await liveTrust(storage, userId, trustToken, now);
  return trustId ? { gated: false, trustId } : { gated: true, row };
}

/** Moves `lastSeenAt` of the trust row that skipped a gate, after the flow's commit. */
export async function touchTrust(
  config: ResolvedConfig,
  trustId: string | null,
  now: Date,
): Promise<void> {
  if (!trustId) return;
  await config.storage.update("trustedDevice", [{ field: "id", op: "eq", value: trustId }], {
    lastSeenAt: now,
    updatedAt: now,
  });
}

/** What a gated sign-in's resolution writes: a session, or a challenge in its place (plan 12c). */
export type Opened =
  | { kind: "session"; token: string; session: SessionRow }
  | { kind: "challenge"; id: string; pending: TwoFactorPending };

/** A gated sign-in's answer for a user with the factor on: the challenge, the landing path, and the user. */
export interface SignInChallenge extends TwoFactorPending {
  next: string;
  user: UserRow;
}

/**
 * The two steps of a gated sign-in (plan 12c): the session steps of plan 9d,
 * with the gate. `before` runs in the resolution's transaction with the user
 * as the resolution leaves it, before its first write. It reads the gate;
 * with no challenge it runs the session hook. `write` writes the session or
 * the challenge, inside the same transaction, so the challenge commits with
 * the claim and the identity link. A claimant and a minted user have no
 * factor row, so they always get a session. A retry calls `before` again,
 * and the newer reads win. `gate: false` (the method's key is off) skips the
 * reads.
 */
export function gatedSteps(
  config: ResolvedConfig,
  open: {
    ip: string | null;
    userAgent: string | null;
    via: Exclude<GatedVia, "password">;
    next: string;
    trustDevice: string | undefined;
    gate: boolean;
    /** The latest expiry of the session (plan 12d): a SAML `SessionNotOnOrAfter`. */
    notAfter?: Date | undefined;
    /** The flow checked the user's address before the hold (`SessionOpen.sameAddress`). */
    sameAddress?: boolean;
    stateData?: OpenedStateData;
    /** The last method of the sign-in (plan 12i Task 12), kept in a challenge for its verify. */
    method?: LastMethod;
  },
  now: Date,
): {
  before(tx: StorageAdapter, user: UserRow): Promise<void>;
  write(tx: StorageAdapter): Promise<Opened>;
  trustId(): string | null;
} {
  let prepared: PreparedSession | null = null;
  let gated: { row: SecondFactorRow; user: UserRow } | null = null;
  let trustId: string | null = null;
  return {
    async before(tx, user) {
      prepared = null;
      gated = null;
      trustId = null;
      const read: GateRead = open.gate
        ? await gateRead(config, tx, user.id, open.trustDevice, now)
        : { gated: false, trustId: null };
      if (read.gated) {
        gated = { row: read.row, user };
        return;
      }
      trustId = read.trustId;
      prepared = await prepareSession(
        config,
        {
          user,
          ip: open.ip,
          userAgent: open.userAgent,
          via: open.via,
          ...(open.notAfter ? { notAfter: open.notAfter } : {}),
          ...(open.sameAddress ? { sameAddress: true } : {}),
        },
        tx,
      );
    },
    async write(tx) {
      const g = gated;
      if (g) {
        const { id, pending } = await writeChallenge(
          config,
          tx,
          g.row,
          {
            userId: g.user.id,
            user: g.user,
            via: open.via,
            from: "sign-in",
            ip: open.ip,
            userAgent: open.userAgent,
            next: open.next,
            notAfter: open.notAfter,
            ...(open.stateData ? { stateData: open.stateData } : {}),
            ...(open.method ? { method: open.method } : {}),
          },
          now,
        );
        return { kind: "challenge", id, pending };
      }
      const p = prepared;
      if (!p) throw new Error("authtempo: the session hook step did not run");
      const s = await writeSession(config, p, tx);
      return { kind: "session", token: s.token, session: s.session };
    },
    trustId: () => trustId,
  };
}
