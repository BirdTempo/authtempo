import type { ResolvedConfig } from "../config.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { IdentityRow, UserRow } from "../schema.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { hasAddress } from "./address.js";
import { requireFresh } from "./fresh.js";
import { hookGuard, runAfter, runBefore, stopWith } from "./hooks.js";
import { sendNotice } from "./notices.js";
import { PENDING_HASH_PREFIX } from "./password.js";
import { phoneSignsIn } from "./phone.js";
import { unchanged } from "./profile.js";
import { later, ROUNDS } from "./second-factor.js";
import type { ResolvedSession } from "./sessions.js";

/**
 * The linked identities and the last-credential guard (plan 12a, spec
 * 8.15). The promise: a user keeps at least one way in. Core owns the
 * guard, so a change of the config cannot break the promise. Every removal
 * of a way in runs through `guardedRemove`.
 */

// Per 15 minutes, per user (plan 12a). A settings page unlinks one or two
// providers. 10 bounds a stolen fresh session that strips an account.
export const UNLINK_PER_USER = { seconds: 900, max: 10 };

/** What a user can sign in with, read now. */
export interface Credentials {
  /** An active password row, not the pending row of a sign-up. A legacy row counts: the legacy seam signs the person in. */
  password: boolean;
  /**
   * The password row is a way in: an identifier that the password sign-in
   * takes reaches it. That is an address, a username with `config.username`
   * on, or a phone that signs in (plan 12i, final review A M1). The guard
   * counts this, not `password`.
   */
  passwordReached: boolean;
  passkeys: number;
  identities: IdentityRow[];
  /**
   * The address is proved, so a mailed proof signs in. The magic link has
   * no off switch (`ROUTES` mounts it in every deployment), so the proved
   * address alone decides. A later switch must change this one line.
   */
  mailbox: boolean;
  /**
   * A phone that signs in (plan 12i): a stored phone counts only with
   * `config.phone` on and a number that the config accepts
   * (`phoneSignsIn`, ruling 15 of plan 12i).
   */
  phone: boolean;
}

export async function credentialsOf(
  config: ResolvedConfig,
  storage: StorageAdapter,
  user: UserRow,
): Promise<Credentials> {
  const row = config.password
    ? await storage.findOne("password", [{ field: "userId", op: "eq", value: user.id }])
    : null;
  const passkeys = config.passkey
    ? (await storage.findMany("passkey", [{ field: "userId", op: "eq", value: user.id }])).length
    : 0;
  const password = row !== null && !row.hash.startsWith(PENDING_HASH_PREFIX);
  const phone = phoneSignsIn(config, user);
  const named = hasAddress(user) || (config.username !== null && user.username !== null) || phone;
  return {
    password,
    passwordReached: password && named,
    passkeys,
    identities: await storage.findMany("identity", [{ field: "userId", op: "eq", value: user.id }]),
    mailbox: hasAddress(user) && user.emailVerified,
    phone,
  };
}

/**
 * A provider identity signs in only while the config names its provider.
 * The config refuses a provider named `email` (`RESERVED_PROVIDER_NAMES`),
 * so the `email` identity never counts here. `mailbox` counts it.
 */
function signsIn(config: ResolvedConfig, identity: IdentityRow): boolean {
  return config.social.providers.some((p) => p.name === identity.provider);
}

function count(config: ResolvedConfig, c: Credentials): number {
  return (
    (c.passwordReached ? 1 : 0) +
    c.passkeys +
    c.identities.filter((i) => signsIn(config, i)).length +
    (c.mailbox ? 1 : 0) +
    (c.phone ? 1 : 0)
  );
}

/** The number of ways in of a user, read through `storage`. */
export async function waysIn(
  config: ResolvedConfig,
  storage: StorageAdapter,
  user: UserRow,
): Promise<number> {
  return count(config, await credentialsOf(config, storage, user));
}

/**
 * Removes a way in under the guard, in one transaction: the lock, the
 * removal, and the recount.
 *
 * The lock is a compare-and-set of the user row through `unchanged()`
 * (profile.ts), and the write moves `updatedAt` past the read. On Postgres
 * the second of two parallel removals waits for the first commit. Its
 * compare then matches no row, so it reads the row again and takes the lock
 * on the new row. Its recount then sees the first removal. On D1 the
 * recount after the write catches the case. After `ROUNDS` lost rounds the
 * answer is `conflict`.
 *
 * `remove` runs only after the lock, so a lost round runs no hook. It
 * answers the number of rows it removed; zero answers `not_found`. Zero
 * ways in after the removal throws, so every adapter undoes the removal,
 * and the answer is `last_credential`. The answer holds the user row as
 * stored after the lock.
 */
export async function guardedRemove(
  config: ResolvedConfig,
  userId: string,
  remove: (tx: StorageAdapter, user: UserRow) => Promise<number>,
  // The fields of the user row that `remove` wrote. The recount reads the
  // row as `remove` left it. The phone remove of plan 12i writes `phone: null`.
  wrote: Partial<UserRow> = {},
): Promise<Result<UserRow>> {
  const now = config.clock.now();
  const byId: Where<"user">[] = [{ field: "id", op: "eq", value: userId }];
  return hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<UserRow>> => {
      let seen = await tx.findOne("user", byId);
      for (let round = 0; round < ROUNDS; round++) {
        if (!seen) return fail("not_found");
        const updatedAt = later(now, seen.updatedAt);
        if ((await tx.update("user", unchanged(seen), { updatedAt })) === 1) {
          const held: UserRow = { ...seen, updatedAt };
          if ((await remove(tx, held)) === 0) stopWith("not_found");
          const left: UserRow = { ...held, ...wrote };
          if ((await waysIn(config, tx, left)) < 1) stopWith("last_credential");
          return ok(left);
        }
        // A parallel write landed first. No write of this call has run.
        seen = await tx.findOne("user", byId);
      }
      config.observe.emit({ name: "credential.removal_gave_up", userId });
      return fail("conflict");
    }),
  );
}

export interface IdentityEntry {
  id: string;
  /** The configured provider name, or `email`. */
  provider: string;
  /** The address, for the `email` identity only. The provider's subject is never in the answer. */
  email?: string;
  linkedAt: Date;
  /** The guard, read now. The unlink runs it again. Always false for `email`. */
  canUnlink: boolean;
}

export interface IdentityList {
  identities: IdentityEntry[];
  password: boolean;
  passkeys: number;
}

/** The identities of the caller (plan 12a). No limit and no fresh rule: the list changes nothing. */
export async function listIdentities(
  config: ResolvedConfig,
  input: { session: ResolvedSession },
): Promise<Result<IdentityList>> {
  const { user } = input.session;
  const c = await credentialsOf(config, config.storage, user);
  const total = count(config, c);
  const identities = [...c.identities]
    .sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime() || a.id.localeCompare(b.id))
    .map((row): IdentityEntry => {
      const base = { id: row.id, provider: row.provider, linkedAt: row.linkedAt };
      if (row.provider === "email") return { ...base, email: row.subject, canUnlink: false };
      return { ...base, canUnlink: total - (signsIn(config, row) ? 1 : 0) >= 1 };
    });
  return ok({ identities, password: c.password, passkeys: c.passkeys });
}

export interface IdentityUnlink {
  session: ResolvedSession;
  /** The identity row id from the list. */
  id: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Unlinks one provider identity of the caller (plan 12a). Fresh rule. No
 * session ends. The answer is `{ ok: true }`, and the client offers the
 * revoke of the other sessions (ASVS 5.0.0 7.4.3 asks for the option).
 *
 * An id of another user's identity answers as an unknown id: the same
 * read, the same `not_found`.
 */
export async function unlinkIdentity(
  config: ResolvedConfig,
  input: IdentityUnlink,
): Promise<Result<{ ok: true }>> {
  const fresh = requireFresh(config, input.session.session);
  if (!fresh.ok) return fresh;
  const userId = input.session.user.id;
  if (!(await limit(config, "unlink:user", userId, UNLINK_PER_USER))) return fail("rate_limited");
  const own: Where<"identity">[] = [
    { field: "id", op: "eq", value: input.id },
    { field: "userId", op: "eq", value: userId },
  ];
  const identity = await config.storage.findOne("identity", own);
  if (!identity) return fail("not_found");
  // The mark of the proved address, not a provider link (`ensureEmailIdentity`).
  if (identity.provider === "email") return fail("invalid_body");
  const summary = { provider: identity.provider, subject: identity.subject };
  const removed = await guardedRemove(config, userId, async (tx, user) => {
    // Read again under the lock: a parallel unlink of this row holds the
    // same lock first, so a gone row runs no hook.
    if (!(await tx.findOne("identity", own))) return 0;
    // Core's check runs before the hook (spec 8.9 item 1), so a refused
    // unlink runs no hook. The recount after the delete stays the guard.
    const taken = signsIn(config, identity) ? 1 : 0;
    if ((await waysIn(config, tx, user)) - taken < 1) stopWith("last_credential");
    await runBefore(config.observe, "identity.beforeUnlink", config.hooks.identity.beforeUnlink, {
      user,
      identity: summary,
    });
    return tx.delete("identity", own);
  });
  if (!removed.ok) return removed;
  await runAfter(
    config.observe,
    "identity.afterUnlink",
    config.hooks.identity.afterUnlink,
    { user: removed.value, identity: summary },
    identity.id,
  );
  // After the commit, never inside the transaction (plan 12a Task 6).
  await sendNotice(config, {
    event: "identity_unlinked",
    email: removed.value.email,
    provider: identity.provider,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ ok: true });
}
