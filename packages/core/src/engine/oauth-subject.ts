import type { ResolvedConfig } from "../config.js";
import { randomBase64Url } from "../primitives/crypto.js";
import { isIpLiteral, isLocalHost } from "../primitives/host.js";
import { newId } from "../primitives/ids.js";
import type { OAuthClientRow } from "../schema.js";
import { StorageError } from "../storage/port.js";

/**
 * Pairwise subjects (plan 12e, owner decision 2, OIDC Core 1.0 section 8,
 * errata set 2, read 2026-10-20). A pairwise client gets one subject per
 * user and sector, so two clients of two sectors cannot join their users.
 * Every path that writes a `sub` for a user asks `subjectFor`. Every path
 * that reads one back asks `userOfSubject`.
 */

export const PAIRWISE_PREFIX = "ps_";
/** 128 random bits: no guess finds the subject of another user (spec 8.16 item 10). */
const SUBJECT_BYTES = 16;

/**
 * The one host of a list of redirect URIs, or null (OIDC Core 8.1). Each
 * URI passed `validRedirectUri`: https, http on a loopback host, or a
 * private-use scheme. A private-use scheme has no host that one party owns,
 * so it gives no sector. Two hosts give no sector either. A loopback or
 * local host gives none: no one party owns it, and every app on a machine
 * or a network can serve it (rulings 32 and 34 of plan 12e). An IP literal
 * gives none (ruling 36).
 */
export function redirectSector(redirectUris: readonly string[]): string | null {
  const hosts = new Set<string>();
  for (const uri of redirectUris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    hosts.add(u.hostname);
  }
  const [host] = hosts;
  if (hosts.size !== 1 || host === undefined) return null;
  return isLocalHost(host) || isIpLiteral(host) ? null : host;
}

/**
 * The sector of a client, or null. A CIMD client's sector is the host of
 * its id, never a redirect host of its document. Only the owner of that
 * host can serve the document. A `cl_` client's sector is the one host of
 * its redirect URIs. `sector_identifier_uri` is not in plan 12e (OIDC Core 8.1).
 */
export function sectorOf(client: OAuthClientRow): string | null {
  if (client.kind === "cimd") return new URL(client.id).hostname;
  return redirectSector(client.redirectUris);
}

/**
 * The `sub` of `userId` for `client`. A public client gets the user id. A
 * pairwise client gets the stored subject of the user and its sector. On a
 * miss this writes a new row; a parallel first write loses on the unique
 * key `(sector, userId)` and reads the winner's row.
 */
export async function subjectFor(
  config: ResolvedConfig,
  userId: string,
  client: OAuthClientRow,
): Promise<string> {
  if (client.subjectType === "public") return userId;
  const sector = sectorOf(client);
  // The metadata rule refuses a pairwise client with no sector, so a row cannot reach this.
  if (sector === null) throw new Error("authtempo: a pairwise client has no sector");
  const where = [
    { field: "sector" as const, op: "eq" as const, value: sector },
    { field: "userId" as const, op: "eq" as const, value: userId },
  ];
  const found = await config.storage.findOne("oauthSubject", where);
  if (found) return found.subject;
  const now = config.clock.now();
  try {
    // A stored random subject: no key ties the subjects for the life of the
    // product. A secret rotation never changes a relying party's users
    // (owner decision 2 of 2026-10-14).
    const row = await config.storage.create("oauthSubject", {
      id: newId(now),
      userId,
      sector,
      subject: PAIRWISE_PREFIX + randomBase64Url(SUBJECT_BYTES),
      createdAt: now,
      updatedAt: now,
    });
    return row.subject;
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    const winner = await config.storage.findOne("oauthSubject", where);
    if (!winner) throw e;
    return winner.subject;
  }
}

/**
 * The `sub` of `userId` for `client` with no write, or null when a pairwise
 * client has no stored subject of the user. The back-channel logout reads
 * it: an account delete removes the user's subjects before the delivery.
 */
export async function storedSubject(
  config: ResolvedConfig,
  userId: string,
  client: OAuthClientRow,
): Promise<string | null> {
  if (client.subjectType === "public") return userId;
  const sector = sectorOf(client);
  if (sector === null) return null;
  const row = await config.storage.findOne("oauthSubject", [
    { field: "sector", op: "eq", value: sector },
    { field: "userId", op: "eq", value: userId },
  ]);
  return row?.subject ?? null;
}

/**
 * The user id of a `sub` that core wrote for `client`, or null. For a
 * pairwise client the sub must be a stored subject of the client's own
 * sector. So a subject of another sector, or of a sector the client left,
 * maps to no user. For a public client the sub is the user id.
 */
export async function userOfSubject(
  config: ResolvedConfig,
  sub: string,
  client: OAuthClientRow,
): Promise<string | null> {
  if (client.subjectType === "public") return sub;
  if (!sub.startsWith(PAIRWISE_PREFIX)) return null;
  const row = await config.storage.findOne("oauthSubject", [
    { field: "subject", op: "eq", value: sub },
  ]);
  return row !== null && row.sector === sectorOf(client) ? row.userId : null;
}
