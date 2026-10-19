import { newId } from "../primitives/ids.js";
import type { OAuthSessionClientRow, SessionRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";

// The writes of the back-channel outbox (plan 12e Task 16). This file signs
// nothing and imports no engine flow, so `sessions.ts` can call it with no
// import cycle. `oauth-logout.ts` delivers the rows.

/**
 * Links a session to a client that got an ID token in it. A second link of
 * the same pair is a `unique_violation`, and the call ignores it. Call it
 * outside a transaction: on Postgres a unique violation ends the
 * transaction that holds it.
 */
export async function linkSession(
  storage: StorageAdapter,
  input: { sessionId: string; clientId: string; userId: string },
  now: Date,
): Promise<void> {
  try {
    await storage.create("oauthSessionClient", {
      id: newId(now),
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
  }
}

/**
 * One outbox row per link, due at `now`, and the delete of each link, in
 * the caller's transaction. A link goes when its logout is written, so a
 * second end of the same session writes no second row.
 */
export async function writeLogouts(
  tx: StorageAdapter,
  links: readonly OAuthSessionClientRow[],
  now: Date,
): Promise<void> {
  for (const link of links) {
    await tx.create("oauthLogout", {
      id: newId(now),
      clientId: link.clientId,
      userId: link.userId,
      sessionId: link.sessionId,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx.delete("oauthSessionClient", [{ field: "id", op: "eq", value: link.id }]);
  }
}

/**
 * The outbox rows of the sessions `sessionIds` of `userId`, in the caller's
 * transaction: a session end by id calls it beside its delete. The read is
 * by user, on the `userId` index, and the ids filter it.
 */
export async function queueLogouts(
  tx: StorageAdapter,
  userId: string,
  sessionIds: readonly string[],
  now: Date,
): Promise<void> {
  const ids = new Set(sessionIds);
  const links = await tx.findMany("oauthSessionClient", [
    { field: "userId", op: "eq", value: userId },
  ]);
  await writeLogouts(
    tx,
    links.filter((l) => ids.has(l.sessionId)),
    now,
  );
}

/**
 * Ends one session by id, with the outbox rows of its client links. It runs
 * on the store, not in a transaction. A sign-out can land while another
 * flow's transaction is open. The memory adapter runs one transaction at a
 * time, so a transaction here would wait for ever. So the outbox write comes
 * first and the delete second. A failure between
 * them sends a logout for a live session: the client ends its session too
 * early, never too late. Two parallel ends can both write a row; a second
 * logout is harmless (Back-Channel Logout 2.7). Answers the delete count.
 */
export async function endSessionById(
  storage: StorageAdapter,
  session: Pick<SessionRow, "id" | "userId">,
  now: Date,
): Promise<number> {
  await queueLogouts(storage, session.userId, [session.id], now);
  return storage.delete("session", [
    { field: "id", op: "eq", value: session.id },
    { field: "userId", op: "eq", value: session.userId },
  ]);
}
