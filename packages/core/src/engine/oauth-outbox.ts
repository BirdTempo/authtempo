import { newId } from "../primitives/ids.js";
import type { OAuthSessionClientRow, SessionRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";

// The writes of the back-channel outbox (plan 12e Task 16). This file signs
// nothing and imports no engine flow, so `sessions.ts` can call it with no
// import cycle. `oauth-logout.ts` delivers the rows.

/**
 * Links a session to a client that got an ID token in it, with the `sid` of
 * that token. A second link of the same pair is a `unique_violation`. The
 * call then answers the `sid` of the first link, so each ID token of one
 * session and one client carries one `sid`. Call it outside a transaction:
 * on Postgres a unique violation ends the transaction that holds it.
 */
export async function linkSession(
  storage: StorageAdapter,
  input: { sessionId: string; clientId: string; userId: string; sid: string },
  now: Date,
): Promise<string> {
  try {
    await storage.create("oauthSessionClient", {
      id: newId(now),
      ...input,
      createdAt: now,
      updatedAt: now,
    });
    return input.sid;
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    const first = await storage.findOne("oauthSessionClient", [
      { field: "sessionId", op: "eq", value: input.sessionId },
      { field: "clientId", op: "eq", value: input.clientId },
    ]);
    // A session end can delete the first link between the two calls. Then this sid stands.
    return first?.sid ?? input.sid;
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
    await createLogout(tx, link, now);
    await tx.delete("oauthSessionClient", [{ field: "id", op: "eq", value: link.id }]);
  }
}

/** The outbox row of one link, due at `now`. */
async function createLogout(
  tx: StorageAdapter,
  link: OAuthSessionClientRow,
  now: Date,
): Promise<void> {
  await tx.create("oauthLogout", {
    id: newId(now),
    clientId: link.clientId,
    userId: link.userId,
    sessionId: link.sessionId,
    sid: link.sid,
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The outbox rows of a page of links, then one delete of the links by id,
 * in the caller's transaction. It sends one statement per link and one
 * more. The sweep passes at most 50 links, and the delete binds their ids.
 * That stays under the 100 bound parameters of a D1 query (D1 limits page
 * updated 21 April 2026, read 2026-10-21).
 */
export async function writeLogoutPage(
  tx: StorageAdapter,
  links: readonly OAuthSessionClientRow[],
  now: Date,
): Promise<void> {
  if (links.length === 0) return;
  for (const link of links) await createLogout(tx, link, now);
  await tx.delete("oauthSessionClient", [{ field: "id", op: "in", value: links.map((l) => l.id) }]);
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
  // By id, as in endSessions: every flow deletes the links in one order.
  const links = await tx.findMany(
    "oauthSessionClient",
    [{ field: "userId", op: "eq", value: userId }],
    { sort: { field: "id", dir: "asc" } },
  );
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
