import type { ResolvedConfig } from "../config.js";
import { sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { VerificationRow } from "../schema.js";
import { IN_CHUNK } from "../storage/batch.js";
import type { Meter } from "../storage/meter.js";
import type { StorageAdapter } from "../storage/port.js";
import { PENDING_END_MS } from "./operator/access-end.js";
import { deleteOrganizationsRest, organizationGroups, organizationList } from "./organizations.js";

/**
 * The rows of the solo organizations of an account delete that wait for the
 * sweep (ruling 78 of plan 12d). On the D1 binding the route of the owner
 * of one solo organization sent 55 to 64 queries, and D1 Free allows 50.
 * So the act deletes the organization rows, the rows that hold a claim or a
 * credential (`deleteOrganizationsHead`), and the member rows. It writes one
 * verification row with this purpose for all of them. The sweep deletes the
 * rest (`deleteOrganizationsRest`): the SCIM Users and Groups, the teams,
 * the invitations, the tokens, and the roles. Each read of those rows needs
 * the organization row or a member row, which the act deleted. So no flow
 * reaches them before the sweep. The one read that has no such step is the
 * pending invitation of an invited sign-up (`mayCreateUser`): it reads the
 * organization of the invitation too.
 */
export const ORGANIZATION_REST = "organization-rest";

/**
 * The pending row of `list`, in the act's transaction: one row for any
 * count, so the act costs no call per organization (ruling 29 of plan 12d).
 * The row names the organizations in `data.organizations`. The expiry is
 * far, as for a pending-end row, so the sweep of expired rows keeps it.
 */
export async function deferOrganizationRest(
  tx: StorageAdapter,
  config: ResolvedConfig,
  list: readonly string[],
  now: Date,
): Promise<void> {
  const id = newId(now);
  await tx.create("verification", {
    id,
    purpose: ORGANIZATION_REST,
    identifier: list[0] ?? id,
    // No code: the hash of the id fills the unique key.
    valueHash: await sha256Hex(`${ORGANIZATION_REST}:${id}`),
    expiresAt: new Date(now.getTime() + PENDING_END_MS),
    consumedAt: null,
    data: { organizations: [...list] },
    secretVersion: config.keyring.current,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The calls of one row of the sweep step at the worst, on the D1 binding
 * (2026-10-24): the group read, the six deletes of the SCIM Users, the
 * teams, the invitations, the tokens, the roles, and the members, the
 * deletes of the group member rows and the groups, the team member delete,
 * the session update (2 on D1: the undo read and the update), and the row
 * delete. A row with more than `IN_CHUNK` groups costs 3: the group read and
 * the two deletes of one chunk of groups. The row then waits for the next
 * sweep.
 */
export const ORGANIZATION_REST_CALLS = 13;

/**
 * The sweep step of the pending rows of `ORGANIZATION_REST`, inside `limit`
 * calls of `meter`. Each row goes in one transaction. The locks come first,
 * in the order of user-hold.ts, as the organization delete takes them: the
 * scimGroup rows, the sessions that act in the organizations, and the
 * scimUser rows. A row whose organizations still hold more than `IN_CHUNK`
 * SCIM Groups loses one chunk of them and stays. The answer is the count of
 * the organizations whose rows went.
 */
export async function sweepOrganizationRest(
  config: ResolvedConfig,
  rows: readonly VerificationRow[],
  meter: Meter,
  limit: number,
): Promise<number> {
  let n = 0;
  for (const row of rows) {
    if (meter.used + ORGANIZATION_REST_CALLS > limit) break;
    const named = row.data?.organizations;
    const list = organizationList(Array.isArray(named) ? named.map(String) : []);
    const done = await config.storage.transaction(async (tx) => {
      // A row that names no organization has no work: it goes.
      if (list.length === 0) {
        await tx.delete("verification", [{ field: "id", op: "eq", value: row.id }]);
        return true;
      }
      const byOrganization = { field: "organizationId", op: "in", value: list } as const;
      await tx.lockInOrder?.("scimGroup", [byOrganization]);
      await tx.lockInOrder?.("session", [{ field: "activeOrganizationId", op: "in", value: list }]);
      await tx.lockInOrder?.("scimUser", [byOrganization]);
      const groups = await organizationGroups(tx, list, IN_CHUNK + 1);
      if (groups.length > IN_CHUNK) {
        const chunk = groups.slice(0, IN_CHUNK);
        await tx.delete("scimGroupMember", [{ field: "groupId", op: "in", value: chunk }]);
        await tx.delete("scimGroup", [{ field: "id", op: "in", value: chunk }]);
        return false;
      }
      await deleteOrganizationsRest(tx, list, groups);
      await tx.delete("verification", [{ field: "id", op: "eq", value: row.id }]);
      return true;
    });
    meter.step(done ? ORGANIZATION_REST_CALLS : 3);
    if (!done) break;
    n += list.length;
  }
  return n;
}
