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

/** The statements of `sweepSetupRows`: one delete for each table. */
export const SETUP_SWEEP_CALLS = 3;

/**
 * Deletes the setup links, the setup sessions, and the test runs past
 * `SETUP_RETENTION_MS`. Each delete is one statement of its own. The links go first, then the
 * sessions, then the runs, the order of each setup write (ruling R22). The answer is the
 * count of the deleted rows.
 */
export async function sweepSetupRows(storage: StorageAdapter, now: Date): Promise<number> {
  const before = new Date(now.getTime() - SETUP_RETENTION_MS);
  const links = await storage.delete("ssoSetupLink", [
    { field: "expiresAt", op: "lt", value: before },
  ]);
  const sessions = await storage.delete("ssoSetupSession", [
    { field: "expiresAt", op: "lt", value: before },
  ]);
  const runs = await storage.delete("ssoTestRun", [
    { field: "createdAt", op: "lt", value: before },
  ]);
  return links + sessions + runs;
}
