import type { ResolvedConfig } from "../config.js";
import type { UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";

/**
 * The account with no address (plan 12i, spec 32 item 1). From schema
 * version 15 a user can have no address: an anonymous user, a phone user,
 * or a user of a passkey sign-up. Each read of an address takes the guard
 * below, never an assertion; a source test holds it.
 */

/** True when the user has an address. The type then reads `email` as a string. */
export function hasAddress(user: UserRow): user is UserRow & { email: string } {
  return user.email !== null;
}

/**
 * True when the user proved a way to reach the person: a verified address,
 * a stored phone (a stored phone is always a proved phone), or a passkey.
 * It reads the passkeys only when the first two checks fail.
 */
export async function verifiedHandle(
  config: ResolvedConfig,
  storage: StorageAdapter,
  user: UserRow,
): Promise<boolean> {
  if (hasAddress(user) && user.emailVerified) return true;
  if (user.phone !== null) return true;
  if (!config.passkey) return false;
  return (
    (await storage.findOne("passkey", [{ field: "userId", op: "eq", value: user.id }])) !== null
  );
}

/**
 * True when the account's own handle is proved: a verified address, or, for
 * a user with no address, an account that is not anonymous. Such a user
 * signed up by a proof that core checked (a phone code or a passkey). The
 * enable of a passkey or a second factor reads it in place of
 * `emailVerified`.
 */
export function provedAccount(user: UserRow): boolean {
  return hasAddress(user) ? user.emailVerified : !user.isAnonymous;
}

/**
 * The order of a member list: by address, then by id. A member with no
 * address sorts after every address, so the order stays total.
 */
export function byAddressThenId(
  a: { email: string | null; id: string },
  b: { email: string | null; id: string },
): number {
  if (a.email !== b.email) {
    if (a.email === null) return 1;
    if (b.email === null) return -1;
    return a.email < b.email ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * The WebAuthn `user.name` of a passkey: the username, the address, the
 * phone, the name, or the app name, in that order. It is never empty.
 */
export function passkeyUserName(config: ResolvedConfig, user: UserRow): string {
  return user.username ?? user.email ?? user.phone ?? user.name ?? config.appName;
}
