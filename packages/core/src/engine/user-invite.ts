import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { sendAccountMail } from "./account-mail.js";
import { keptClaimEnded, verifySteps } from "./create-steps.js";
import { hookGuard } from "./hooks.js";
import { gatedSteps, type SignInChallenge, touchTrust } from "./second-factor.js";
import { challengeOpened, endedList, sessionOpened, sessionsEnded } from "./sessions.js";
import { enforcedAnswer } from "./sso/enforce.js";
import {
  claimEmail,
  claimedUser,
  claimRetry,
  claimRetryWait,
  ensureEmailIdentity,
} from "./users.js";
import { consumeVerification } from "./verification.js";

/**
 * The invitation link of a user that an operator created (plan 12f2 Task 3,
 * spec 26). The create writes one `user-invite` row in its transaction and
 * mails the link after the commit. The link opens the first session of the
 * person and proves the address. The token leaves core only in the mail.
 */

export const USER_INVITE_PREFIX = "ui_";
export const USER_INVITE_TOKEN_RE = /^ui_[A-Za-z0-9_-]{43}$/;
/** Each POST of the confirm costs a hash and a read, and a right token opens a session. */
export const INVITE_CONFIRM_PER_IP = { seconds: 15 * 60, max: 20 };

export interface UserInviteConfirm {
  token: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 12c): it skips the gate. */
  trustDevice?: string | undefined;
}

/**
 * Writes the invitation row of a created user, in the transaction of the
 * create, and answers the clear token. The identifier is the user id, so
 * the account delete takes the row. The data holds the address at the
 * create: the confirm refuses the row after a change of address (plan 12f2
 * deviation 4). The row lives `operator.invite.ttlHours`.
 */
export async function writeUserInvite(
  tx: StorageAdapter,
  config: ResolvedConfig,
  user: UserRow & { email: string },
  now: Date,
): Promise<string> {
  const ttlHours = config.operator?.invite.ttlHours ?? 72;
  const token = randomToken(USER_INVITE_PREFIX);
  await tx.create("verification", {
    id: newId(now),
    purpose: "user-invite",
    identifier: user.id,
    valueHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + ttlHours * 3_600_000),
    consumedAt: null,
    data: { email: user.email },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  return token;
}

/**
 * Mails the invitation link through `account.mail` (kind `user_invite`),
 * after the commit of the create. Core passes no operator name and no IP.
 * A throw of the mail port passes to the caller.
 */
export async function mailUserInvite(
  config: ResolvedConfig,
  email: string,
  token: string,
): Promise<void> {
  await sendAccountMail(config, {
    kind: "user_invite",
    email,
    link: `${config.baseURL}${config.basePath}/user/invite/confirm?token=${encodeURIComponent(token)}`,
    ttlHours: config.operator?.invite.ttlHours ?? 72,
    appName: config.appName,
  });
}

/**
 * The confirm of an invitation link (the POST). The order: the per-IP
 * limit, the token form, then one transaction. In it, the spend of the row
 * comes first, in one conditional update; its D1 undo is exact, so a hook
 * that refuses leaves the link usable. Then the user by the row's
 * identifier: a gone user, or a user whose address is not the row's
 * address, answers `invalid_token` and the link stays spent. Then the SSO
 * door: an address of an enforced domain answers `sso_required` (plan 12d,
 * spec 30 item 12). Then `user.beforeVerify` of an unverified user, the
 * gate reads and the session hook, the `email` identity, the claim of an
 * unverified user, and the session or the challenge. The claim deletes the
 * claimant's credentials, sessions, and handoff codes, and clears the
 * username and the phone (`claimEmail`). A claimant's session had no
 * verified powers (plan 12p), so it made no token, grant, or factor to keep.
 *
 * A wrong, spent, or expired token answers one code, `invalid_token`. A
 * user with the second factor on gets a challenge in place of the session,
 * unless `totp.gate.invite` is false or a trust token of the user comes
 * with the request (plan 12c).
 */
export async function confirmUserInvite(
  config: ResolvedConfig,
  input: UserInviteConfirm,
): Promise<Result<{ token: string; next: string; user: UserRow } | SignInChallenge>> {
  if (!config.operator?.users) return fail("not_found");
  if (!(await limit(config, "user-invite-confirm:ip", ipKey(input.ip), INVITE_CONFIRM_PER_IP)))
    return fail("rate_limited");
  if (!USER_INVITE_TOKEN_RE.test(input.token)) return fail("invalid_token");
  const valueHash = await sha256Hex(input.token);
  const now = config.clock.now();
  // The invitation has no landing path of its own: the person lands on the app root.
  const next = "/";
  const ended = endedList(config);
  const steps = gatedSteps(
    config,
    {
      ip: input.ip,
      userAgent: input.userAgent,
      via: "invite",
      method: "magic_link",
      next,
      trustDevice: input.trustDevice,
      gate: config.totp?.gate.invite ?? false,
    },
    now,
  );
  const verified = verifySteps(config, "invite");
  let answer: Result<UserRow> | null = null;
  let opened: Awaited<ReturnType<typeof steps.write>> | null = null;
  // The claim retries, apart from the unique-key retry (CLAIM_RUNS).
  let lost = 0;
  for (let attempt = 0; answer === null; attempt++) {
    try {
      answer = await hookGuard(() =>
        config.storage.transaction(async (tx): Promise<Result<UserRow>> => {
          // A retry runs again from the spend. The rows of an attempt that rolled back did not end.
          if (ended) ended.length = 0;
          verified.begin();
          opened = null;
          const consumed = await consumeVerification(tx, {
            purpose: "user-invite",
            valueHash,
            now,
          });
          if (!consumed.ok) return fail("invalid_token");
          const email = (consumed.value.data as { email?: unknown } | null)?.email;
          const user = await tx.findOne("user", [
            { field: "id", op: "eq", value: consumed.value.identifier },
          ]);
          // The address binds the link (plan 12f2 deviation 4): after a change
          // of address, the old mailbox must not open the account.
          if (!user || typeof email !== "string" || user.email !== email)
            return fail("invalid_token");
          // Only SSO signs in an address of an enforced domain (plan 12d, spec 30 item 12).
          const enforced = await enforcedAnswer(config, email, tx);
          if (enforced) return enforced;
          const resolved = user.emailVerified ? user : claimedUser(user, now);
          // `user.beforeVerify`, then the gate reads and the session hook,
          // before the identity and the claim: the D1 undo (`BeforeResolveWrite` of users.ts).
          if (!user.emailVerified) await verified.before(user);
          await steps.before(tx, resolved);
          await ensureEmailIdentity(tx, user.id, email, now, verified);
          if (!user.emailVerified) {
            await claimEmail(tx, user.id, null, now, verified, ended);
            // A mailbox proof is final (plan 12o): a later throw keeps the claim.
            // The spend and the `email` identity came before it, so they stay too.
            await verified.keep(tx, resolved);
          }
          opened = await steps.write(tx);
          return ok(resolved);
        }),
      );
    } catch (err) {
      // A kept claim cannot run again (plan 12o): its after points fire, and the error passes on.
      if (verified.kept()) {
        await keptClaimEnded(config, verified, ended);
        throw err;
      }
      // A parallel repair of the `email` identity: the retry finds its row.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        err.model === "identity"
      )
        continue;
      // Another proof claimed the user first. The rollback undid the spend,
      // so the retry spends the link again.
      const next = claimRetry(config.storage, err, lost++);
      if (next === "retry") {
        await claimRetryWait(err);
        continue;
      }
      if (next === "conflict") {
        // The link stays usable, so no new mail goes (plan 12o).
        verified.flipLost();
        answer = fail("conflict");
      } else throw err;
    }
  }
  if (!answer.ok) {
    // An error answer after a kept claim: the claim's after points (plan 12o).
    await keptClaimEnded(config, verified, ended);
    return answer;
  }
  const user = answer.value;
  const after = opened as Awaited<ReturnType<typeof steps.write>> | null;
  if (!after) throw new Error("authtempo: the invitation opened no session");
  // After the commit, before the session hook and before a challenge answer (plan 12a).
  await verified.after(user);
  await sessionsEnded(config, ended, "claim", verified.stops, verified.endedCount());
  if (after.kind === "challenge") {
    challengeOpened(config, user, "invite");
    return ok({ ...after.pending, next, user });
  }
  await touchTrust(config, steps.trustId(), now);
  await sessionOpened(config, after.session, user, "invite");
  return ok({ token: after.token, next, user });
}
