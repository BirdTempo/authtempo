import type { StorageAdapter } from "../../storage/port.js";

/**
 * Holds a setup link live inside the transaction of a write (plan 13a Task 4, review of round 1).
 * One conditional update of the link row: the where holds the link not revoked, not ended, and
 * not expired. It writes `updatedAt` only. So the transaction takes the row lock of the link,
 * as `openSetupSession` does. A revoke or an activation in parallel then commits before this
 * update, and the update changes no row, or it waits for this commit. No draft, domain, or
 * token write lands after the end of its link.
 *
 * It answers false when the link is not live. The caller then answers `unauthorized`, the
 * answer of `requireSetupSession` for a link that has ended.
 */
export async function holdLinkLive(
  tx: StorageAdapter,
  linkId: string,
  now: Date,
): Promise<boolean> {
  const n = await tx.update(
    "ssoSetupLink",
    [
      { field: "id", op: "eq", value: linkId },
      { field: "revokedAt", op: "eq", value: null },
      { field: "endedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { updatedAt: now },
  );
  return n > 0;
}
