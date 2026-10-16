import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { ipKey } from "../limiter/ip-key.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationPurpose, VerificationRow } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import type { AccountMailInput } from "./account-mail.js";
import { checkCode, consumeCode, issueCode, newestCode, verifyGate } from "./email-otp.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import { sendNotice } from "./notices.js";
import { unchanged } from "./profile.js";
import { later, ROUNDS } from "./second-factor.js";
import { endOtherAccess } from "./session-list.js";
import {
  endedList,
  type PublicUser,
  publicUser,
  type ResolvedSession,
  sessionsEnded,
} from "./sessions.js";
import { ensureEmailIdentity, normalizeEmail } from "./users.js";
import { consumeVerification } from "./verification.js";

/**
 * The change of address (plan 12a, spec 8.15). A fresh session of a verified
 * user asks for a new address. Core sends a proof to the new address. The
 * spend of the proof moves the address, and a notice goes to the old one
 * (owner decision 2). The proof is a link (an `ec_` token with the magic
 * link's life) or a code (the email code rules). One request per user is live.
 */

export const EMAIL_CHANGE_PREFIX = "ec_";
export const EMAIL_CHANGE_TOKEN_RE = /^ec_[A-Za-z0-9_-]{43}$/;
// Per hour, per user (plan 12a). A person who mistypes asks a few times; 5
// bounds a stolen fresh session that mails strangers.
const CHANGE_PER_USER = { seconds: 3600, max: 5 };
// Per 15 minutes, per new address (plan 12a), after the per-user key: one
// address gets at most 3 proofs or notes, whoever asks.
const CHANGE_PER_NEW_EMAIL = { seconds: 900, max: 3 };
// Per 15 minutes, per IP, for the link confirm (plan 12a). The 32-byte token
// is the proof; the key bounds a loop of guesses and a busy scanner.
export const CONFIRM_PER_IP = { seconds: 900, max: 20 };

const CHANGE_PURPOSES: readonly VerificationPurpose[] = ["email-change", "email-change-otp"];
/**
 * The proofs that the old mailbox holds. After the move no user has the old
 * address, so a live magic link there would make a new user. A live reset
 * there would set a password and end the sessions.
 */
const OLD_ADDRESS_PROOFS: readonly VerificationPurpose[] = [
  "magic-link",
  "password-reset",
  "email-otp",
  "password-reset-otp",
  "reauth-otp",
];

interface ChangeData {
  newEmail: string;
  /** The address of the requesting session at the request. The move and the notice use it. */
  oldEmail: string;
  sessionId: string;
  next: string;
  /**
   * True on a decoy row: a user held the new address at the request. Its
   * proof was never mailed, and it never moves the address (review M1).
   */
  taken: boolean;
}

function changeData(row: VerificationRow): ChangeData | null {
  const d = row.data as Partial<Record<keyof ChangeData, unknown>> | null;
  if (
    !d ||
    typeof d.newEmail !== "string" ||
    typeof d.oldEmail !== "string" ||
    typeof d.sessionId !== "string"
  )
    return null;
  return {
    newEmail: d.newEmail,
    oldEmail: d.oldEmail,
    sessionId: d.sessionId,
    next: safeNext(d.next),
    taken: d.taken === true,
  };
}

/** A proof mail to its own address, whatever `to` the builder answers. */
async function mailTo(config: ResolvedConfig, input: AccountMailInput): Promise<void> {
  const message = config.account.mail(input);
  await config.mail.send({ ...message, to: input.email });
}

export interface EmailChangeRequest {
  session: ResolvedSession;
  newEmail: string;
  /** `link` (default) or `code`. `code` needs `emailOtp`, and suits a native app. */
  method?: "link" | "code" | undefined;
  /** Where the confirm page lands. The rules of `safeNext`. */
  next?: string | undefined;
}

/**
 * Sends a proof to the new address, or, when any user holds it, a note with
 * no proof. Both answer `{ sent: true }`: the note reaches the owner of the
 * mailbox only, so the requester learns nothing. Both paths count the same
 * keys, spend the earlier proofs, and write a row, in the same order. The
 * row of a taken address is a decoy that never moves the address.
 */
export async function requestEmailChange(
  config: ResolvedConfig,
  input: EmailChangeRequest,
): Promise<Result<{ sent: true }>> {
  const { user, session } = input.session;
  // Every check that needs no count comes first, so a refused call fills no key.
  if (!user.emailVerified) return fail("email_unverified");
  const fresh = requireFresh(config, session);
  if (!fresh.ok) return fresh;
  const method = input.method ?? "link";
  if (method !== "link" && method !== "code") return fail("invalid_body");
  const otp = config.emailOtp;
  if (method === "code" && !otp) return fail("not_found");
  const newEmail = typeof input.newEmail === "string" ? normalizeEmail(input.newEmail) : null;
  if (newEmail === null || newEmail === user.email) return fail("invalid_body");
  if (!(await config.limiter.allow(`email-change:user:${user.id}`, CHANGE_PER_USER)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`email-change:email:${newEmail}`, CHANGE_PER_NEW_EMAIL)))
    return fail("rate_limited");
  const now = config.clock.now();
  // One live request per user: the earlier links and codes stop working.
  await config.storage.update(
    "verification",
    [
      { field: "purpose", op: "in", value: CHANGE_PURPOSES },
      { field: "identifier", op: "eq", value: user.id },
      { field: "consumedAt", op: "eq", value: null },
    ],
    { consumedAt: now, updatedAt: now },
  );
  const token = randomToken(EMAIL_CHANGE_PREFIX);
  const valueHash = await sha256Hex(token);
  const appName = config.appName;
  // A taken address gets a decoy row: the same writes in the same order, so
  // the time, the later verify answers, and the verify keys tell nothing
  // (review M1 and m2). Only the mail differs, and the owner of the mailbox reads it.
  const taken =
    (await config.storage.findOne("user", [{ field: "email", op: "eq", value: newEmail }])) !==
    null;
  const data = {
    newEmail,
    oldEmail: user.email,
    sessionId: session.id,
    next: safeNext(input.next),
    taken,
  };
  const note = () => mailTo(config, { kind: "email_change_taken", email: newEmail, appName });
  if (method === "code" && otp) {
    const code = await issueCode(config, otp, "email-change-otp", user.id, data);
    if (taken) await note();
    else
      await mailTo(config, {
        kind: "email_change_code",
        email: newEmail,
        code,
        ttlMinutes: otp.ttlMinutes,
        appName,
      });
    return ok({ sent: true });
  }
  const ttlMinutes = config.magicLink.ttlMinutes;
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "email-change",
    identifier: user.id,
    valueHash,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    consumedAt: null,
    data: { ...data, attempts: 0 },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  if (taken) {
    await note();
    return ok({ sent: true });
  }
  const link = `${config.baseURL}${config.basePath}/user/change-email/confirm?token=${encodeURIComponent(token)}`;
  await mailTo(config, { kind: "email_change_link", email: newEmail, link, ttlMinutes, appName });
  return ok({ sent: true });
}

interface Applied {
  previous: UserRow;
  user: UserRow;
}

interface Move {
  row: VerificationRow;
  data: ChangeData;
  /** The answer when the row moved since the request: `invalid_token` for a link, `invalid_code` for a code. */
  lost: "invalid_token" | "invalid_code";
  /** The session that stays. */
  keep: string;
  /** Spends the proof in the transaction. A failure undoes the move. */
  consume: (tx: StorageAdapter) => Promise<Result<VerificationRow>>;
  ended: SessionRow[] | undefined;
}

/**
 * The move, in one transaction. Its first write is the compare-and-set on
 * the user row (`unchanged`, the profile update's rule). The spend of the
 * proof follows it. So two confirms of one proof wait on the user row on
 * Postgres: the loser finds the new address and answers `lost`. A parallel
 * profile update makes a round lose: the move reads the row again and runs
 * `user.beforeUpdate` again. After `ROUNDS` lost rounds it answers
 * `conflict`. Any user at the new address answers `email_taken`: core never
 * moves an address onto another account. A unique-key race of two users who
 * confirm one address is caught outside the transaction.
 */
async function applyChange(config: ResolvedConfig, move: Move): Promise<Result<Applied>> {
  const now = config.clock.now();
  const { data } = move;
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: move.row.identifier }];
  try {
    return await hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<Applied>> => {
        let previous = await tx.findOne("user", byId);
        for (let round = 0; round < ROUNDS; round++) {
          // A delete, or another move since the request. No write has run.
          if (!previous || previous.email !== data.oldEmail) return fail(move.lost);
          if (await tx.findOne("user", [{ field: "email", op: "eq", value: data.newEmail }]))
            return fail("email_taken");
          // Before the write, so a stop leaves both rows as they were on every adapter, D1 too.
          await runBefore("user.beforeUpdate", config.hooks.user.beforeUpdate, {
            user: previous,
            patch: { email: data.newEmail },
            via: "email_change",
          });
          const updatedAt = later(now, previous.updatedAt);
          const moved = await tx.update("user", unchanged(previous), {
            email: data.newEmail,
            emailVerified: true,
            updatedAt,
          });
          if (moved === 1) {
            const consumed = await move.consume(tx);
            // The proof was spent, expired, or replaced since the read: undo the move.
            if (!consumed.ok) stopWith(consumed.code);
            // The `email` identity follows the address: it marks the mailbox that signs in by magic link.
            const renamed = await tx.update(
              "identity",
              [
                { field: "provider", op: "eq", value: "email" },
                { field: "userId", op: "eq", value: previous.id },
                { field: "subject", op: "eq", value: data.oldEmail },
              ],
              { subject: data.newEmail, updatedAt: now },
            );
            if (renamed === 0) await ensureEmailIdentity(tx, previous.id, data.newEmail, now);
            await tx.delete("verification", [
              { field: "purpose", op: "in", value: OLD_ADDRESS_PROOFS },
              { field: "identifier", op: "eq", value: data.oldEmail },
            ]);
            await endOtherAccess(tx, previous.id, move.keep, move.ended ?? null);
            return ok({
              previous,
              user: { ...previous, email: data.newEmail, emailVerified: true, updatedAt },
            });
          }
          // A parallel write landed first. Read the row again.
          previous = await tx.findOne("user", byId);
        }
        console.error("authtempo: email change gave up", move.row.identifier);
        return fail("conflict");
      }),
    );
  } catch (err) {
    // Two users confirm one new address at once: the loser breaks the unique
    // key of `user.email`. It is caught here, outside: inside, Postgres has
    // already aborted the transaction. The move writes the user row first, so
    // the user key fails first. The `identity` branch is a second guard: only
    // an `email` identity of another user at the new address, with no user
    // row there, reaches it, and no flow leaves that state (review L3).
    if (
      err instanceof StorageError &&
      err.code === "unique_violation" &&
      (err.model === "user" || err.model === "identity")
    )
      return fail("email_taken");
    throw err;
  }
}

/**
 * The steps after the commit: the update hook, the ended sessions, and the
 * notice. The notice goes to the address of the request, never to an
 * address that a read after the commit finds.
 */
async function finish(
  config: ResolvedConfig,
  move: Move,
  applied: Applied,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  await runAfter(
    "user.afterUpdate",
    config.hooks.user.afterUpdate,
    { user: applied.user, previous: applied.previous, via: "email_change" },
    applied.user.id,
  );
  await sessionsEnded(config, move.ended, "email_change");
  await sendNotice(config, {
    event: "email_changed",
    email: move.data.oldEmail,
    newEmail: move.data.newEmail,
    ip,
    userAgent,
  });
}

/** The confirm by link. It needs no session: the person may open the mail on another device. */
export async function confirmEmailChange(
  config: ResolvedConfig,
  input: { token: string; ip: string | null; userAgent: string | null },
): Promise<Result<{ user: PublicUser; next: string }>> {
  if (typeof input.token !== "string" || !EMAIL_CHANGE_TOKEN_RE.test(input.token))
    return fail("invalid_token");
  if (!(await config.limiter.allow(`email-change-confirm:ip:${ipKey(input.ip)}`, CONFIRM_PER_IP)))
    return fail("rate_limited");
  const valueHash = await sha256Hex(input.token);
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "email-change" },
  ]);
  if (!row) return fail("invalid_token");
  const now = config.clock.now();
  // Before the hook: a spent or old link runs no app code. The spend in the transaction decides a race.
  if (row.consumedAt !== null) return fail("invalid_token");
  if (row.expiresAt.getTime() <= now.getTime()) return fail("token_expired");
  const data = changeData(row);
  // A decoy row answers as an unknown link. Its token was never mailed.
  if (!data || data.taken) return fail("invalid_token");
  const move: Move = {
    row,
    data,
    lost: "invalid_token",
    keep: data.sessionId,
    consume: (tx) => consumeVerification(tx, { purpose: "email-change", valueHash, now }),
    ended: endedList(config),
  };
  const applied = await applyChange(config, move);
  if (!applied.ok) return applied;
  await finish(config, move, applied.value, input.ip, input.userAgent);
  return ok({ user: publicUser(applied.value.user), next: data.next });
}

/**
 * The confirm by code. It needs a session of the same user: a 6-digit code
 * is not a bearer proof. The caller's session stays. The verify keys of
 * every mailed code apply, on the new address.
 */
export async function verifyEmailChange(
  config: ResolvedConfig,
  input: { session: ResolvedSession; code: string; ip: string | null; userAgent: string | null },
): Promise<Result<{ user: PublicUser }>> {
  if (!config.emailOtp) return fail("not_found");
  const { user, session } = input.session;
  const live = await newestCode(config.storage, "email-change-otp", user.id);
  const target = live ? changeData(live) : null;
  // With no request there is no new address. The empty text keys the IP only,
  // so a guess costs the owner's own sign-in budget nothing.
  const gate = await verifyGate(config, { email: target?.newEmail ?? "", ip: input.ip });
  if (!gate.ok) return gate;
  const now = config.clock.now();
  const checked = await checkCode(config, "email-change-otp", user.id, input.code, now);
  if (!checked.ok) return checked;
  const data = changeData(checked.value);
  // A decoy row answers as a wrong code. Wrong guesses counted on it, as on a real row.
  if (!data || data.taken) return fail("invalid_code");
  const row = checked.value;
  const move: Move = {
    row,
    data,
    lost: "invalid_code",
    keep: session.id,
    consume: (tx) => consumeCode(tx, row, now),
    ended: endedList(config),
  };
  const applied = await applyChange(config, move);
  if (!applied.ok) return applied;
  await finish(config, move, applied.value, input.ip, input.userAgent);
  return ok({ user: publicUser(applied.value.user) });
}
