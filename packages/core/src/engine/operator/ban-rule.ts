import type { UserRow } from "../../schema.js";

/**
 * True while a ban holds (spec 26 item 6): `bannedAt` is set, and the ban
 * has no end or ends after `now`. At `banUntil` the ban has ended. A ban
 * that ended reads as no ban; its fields stay until an unban or a new ban.
 * A pure rule: each door of plan 12f passes the user row that it read.
 */
export function activeBan(user: Pick<UserRow, "bannedAt" | "banUntil">, now: Date): boolean {
  if (user.bannedAt === null) return false;
  return user.banUntil === null || user.banUntil.getTime() > now.getTime();
}
