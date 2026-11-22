import type { StorageAdapter } from "../../storage/port.js";

/**
 * How long the setup rows stay after they end (plan 13a, ruling R30). One source for
 * the three tables: a setup link and a setup session, counted from their `expiresAt`,
 * and a test run, counted from its `createdAt`.
 *
 * The reason: a link lives 168 hours at most, and a link or a session that ended or
 * expired opens no route. So no flow reads such a row. A link holds the name of an
 * IT contact in `note`, and a test run holds the names of attributes, so a row that
 * no flow reads must not stay for ever. The 30 days leave the owner time to read the
 * link list and the audit rows beside it after a setup. After that the sweep deletes
 * the row, and the note goes with it. The same bound keeps the three tables small,
 * so the organization delete needs no `organization_id` index on them.
 */
export const SETUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The links that one sweep deletes at most. D1 binds 100 parameters for a query, and the
 * delete of the pending tokens binds one for each link and one more (ruling R33). The rest
 * goes in the next sweep.
 */
export const SETUP_SWEEP_LINKS = 50;

/**
 * The most statements of `sweepSetupRows`: the read of the links, the delete of their pending
 * tokens, the delete of the links, the delete of the sessions, and the delete of the runs. A
 * sweep with no ended link sends 3: it skips the two deletes of the links. Measured on D1 in
 * packages/adapter-d1/test/sso-setup-sweep-budget.test.ts (3 idle, 5 with a page).
 */
export const SETUP_SWEEP_CALLS = 5;
const SETUP_SWEEP_CALLS_IDLE = 3;

/**
 * Deletes the setup links, the setup sessions, and the test runs past
 * `SETUP_RETENTION_MS`. A link that goes takes its pending SCIM token with it: a pending token
 * opens no directory, and no flow reads it once its link has ended (ruling R33). A token with
 * `pending` false is a live token of the organization, and it stays. The token goes before
 * its link, then the sessions, then the runs, the order of each setup write (ruling R22). The
 * answer is the count of the deleted links, sessions, and runs, and the count of the statements
 * that it sent, for the call meter of the sweep.
 */
export async function sweepSetupRows(
  storage: StorageAdapter,
  now: Date,
): Promise<{ rows: number; calls: number }> {
  const before = new Date(now.getTime() - SETUP_RETENTION_MS);
  const ended = await storage.findMany(
    "ssoSetupLink",
    [{ field: "expiresAt", op: "lt", value: before }],
    { limit: SETUP_SWEEP_LINKS },
  );
  let links = 0;
  if (ended.length > 0) {
    const ids = ended.map((l) => l.id);
    await storage.delete("scimToken", [
      { field: "setupLinkId", op: "in", value: ids },
      { field: "pending", op: "eq", value: true },
    ]);
    links = await storage.delete("ssoSetupLink", [{ field: "id", op: "in", value: ids }]);
  }
  const sessions = await storage.delete("ssoSetupSession", [
    { field: "expiresAt", op: "lt", value: before },
  ]);
  const runs = await storage.delete("ssoTestRun", [
    { field: "createdAt", op: "lt", value: before },
  ]);
  return {
    rows: links + sessions + runs,
    calls: ended.length > 0 ? SETUP_SWEEP_CALLS : SETUP_SWEEP_CALLS_IDLE,
  };
}
