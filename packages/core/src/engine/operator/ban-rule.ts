import type { UserRow } from "../../schema.js";

/**
 * True while a ban holds (spec 26 item 6): `bannedAt` is set, and the ban
 * has no end or ends after `now`. At `banUntil` the ban has ended. A ban
 * that ended reads as no ban, and its fields stay. The unban ends a ban by
 * a write of `banUntil` (ruling 28). A pure rule: each door of plan 12f
 * passes the user row that it read.
 */
export function activeBan(user: Pick<UserRow, "bannedAt" | "banUntil">, now: Date): boolean {
  if (user.bannedAt === null) return false;
  return user.banUntil === null || user.banUntil.getTime() > now.getTime();
}

/**
 * True when a credential issued at `issuedAt` came before the end of the
 * last ban of the user (ruling 28): `bannedAt` is set, and the ban has no
 * end or ends after `issuedAt`. The ban ended every session in its
 * transaction. So a session that exists while a ban holds is a race row,
 * and this rule ends it also after the unban or the end of the ban. A
 * credential issued at or after the end passes. A ban that holds now makes
 * this rule true for each credential that exists now.
 */
export function bannedFor(user: Pick<UserRow, "bannedAt" | "banUntil">, issuedAt: Date): boolean {
  if (user.bannedAt === null) return false;
  return user.banUntil === null || issuedAt.getTime() < user.banUntil.getTime();
}
