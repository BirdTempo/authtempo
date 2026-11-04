import type { ResolvedConfig } from "../config.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import { phoneSignsIn } from "./phone.js";

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
 * a phone that signs in, or a passkey. A stored phone counts only with
 * `config.phone` on (`phoneSignsIn`, ruling 15 of plan 12i). It reads the
 * passkeys only when the other checks fail.
 */
export async function verifiedHandle(
  config: ResolvedConfig,
  storage: StorageAdapter,
  user: UserRow,
): Promise<boolean> {
  if (hasAddress(user) && user.emailVerified) return true;
  if (phoneSignsIn(config, user)) return true;
  if (!config.passkey) return false;
  return (
    (await storage.findOne("passkey", [{ field: "userId", op: "eq", value: user.id }])) !== null
  );
}

/**
 * The caller of a verified-only check (plan 12p, spec 8.9): the user, and
 * the session that the request resolved. A route passes the session it
 * holds. A caller with no session is a `tk_` token, or a user that the app
 * passes itself. It keeps the user row's rule: a token needs a proved
 * session at its creation.
 */
export interface ProofCaller {
  user: UserRow;
  session?: Pick<SessionRow, "proved"> | null | undefined;
}

/**
 * False when the caller's session was made before the proof of its user
 * (plan 12p). The flag is set once, at the session's creation. So the
 * session of a claimant stays unproved after the claim's flip, and acts as
 * unverified until the claim deletes it. A caller with no session passes.
 */
export function sessionProved(caller: ProofCaller): boolean {
  return caller.session == null || caller.session.proved;
}

/**
 * True when the caller may change what the owner of the account keeps
 * (ruling 15 of plan 12i). That is a verified address, or a verified handle
 * for a user with no address, read with the flag of the caller's session
 * (plan 12p). A claimant's session has neither, so the claim leaves no way
 * in that the claimant set. The profile update, the API tokens, the
 * username, the phone add, and the change of address read it. The factor
 * reads `provedAccount`. The two differ for a user with no address whose
 * handle does not sign in now, such as a phone outside the regions. That
 * user is not anonymous, but has no verified handle here.
 */
export async function handleProved(
  config: ResolvedConfig,
  storage: StorageAdapter,
  caller: ProofCaller,
): Promise<boolean> {
  if (!sessionProved(caller)) return false;
  const { user } = caller;
  return hasAddress(user) ? user.emailVerified : verifiedHandle(config, storage, user);
}

/**
 * True when the account's own handle is proved: a verified address, or, for
 * a user with no address, an account that is not anonymous. Such a user
 * signed up by a proof that core checked (a phone code or a passkey). The
 * flag of the caller's session must hold too (plan 12p). The enable of a
 * passkey or a second factor and the OAuth grants read it in place of
 * `emailVerified`.
 */
export function provedAccount(caller: ProofCaller): boolean {
  if (!sessionProved(caller)) return false;
  const { user } = caller;
  return hasAddress(user) ? user.emailVerified : !user.isAnonymous;
}

/**
 * True when the caller's address is verified, read with the flag of the
 * caller's session (plan 12p). The organization, team, invitation, SSO,
 * operator, and link checks read it. A user with no address fails it, as
 * the address check did before.
 */
export function provedAddress(caller: ProofCaller): boolean {
  return sessionProved(caller) && caller.user.emailVerified;
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
