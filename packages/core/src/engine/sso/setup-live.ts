import { fail, ok, type Result } from "../../result.js";
import type { OrganizationRow, SsoSetupLinkRow } from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { lockOrganization } from "../teams.js";

/** The link step of `lockSetupRows`: the link row to hold, and what the update writes. */
export type SetupLinkLock = {
  id: string;
  now: Date;
  /** The fields that the update of the link writes beside `updatedAt`. */
  set?: Partial<SsoSetupLinkRow>;
  /** "accept" holds a link past its `expiresAt` too: a revoke ends such a link. Default "refuse". */
  whenExpired?: "refuse" | "accept";
};

/**
 * The one lock order of each setup write (ruling R22 of plan 13a): the
 * organization row first, then the link row. The caller writes the session
 * rows or the test run rows after this call, so they come third. Each setup write calls this
 * helper first in its transaction, and no setup write has an order of its
 * own. The organization delete locks the organization row, and then deletes
 * the setup links, then the setup sessions (`deleteOrganizationsRest`). So
 * a setup write and a delete take the rows in one order. The reverse order
 * made a deadlock on Postgres (40P01), and the caller got a 500.
 *
 * The helper reads and locks the organization row (`lockOrganization`).
 * Then, when `link` is set, one conditional update holds the link row. The
 * where holds the link not revoked, not ended, and not expired. The update
 * writes `updatedAt` and the fields of `link.set`. A revoke or an activation
 * in parallel then commits before this update, and the update changes no
 * row, or it waits for this commit. So no setup write lands after the end
 * of its link.
 *
 * It answers the organization row. With no `link`, an organization that is
 * gone answers `not_found`. With a `link`, an organization that is gone and
 * a link that is not live answer `unauthorized`: the answer of
 * `requireSetupSession` for a link that has ended or a deleted organization.
 */
export async function lockSetupRows(
  tx: StorageAdapter,
  organizationId: string,
  link: SetupLinkLock | null,
): Promise<Result<OrganizationRow>> {
  const gone = link === null ? "not_found" : "unauthorized";
  const organization = await tx.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization || !(await lockOrganization(tx, organization))) return fail(gone);
  if (link === null) return ok(organization);
  const n = await tx.update(
    "ssoSetupLink",
    [
      { field: "id", op: "eq", value: link.id },
      { field: "organizationId", op: "eq", value: organizationId },
      { field: "revokedAt", op: "eq", value: null },
      { field: "endedAt", op: "eq", value: null },
      ...(link.whenExpired === "accept"
        ? []
        : ([{ field: "expiresAt", op: "gt", value: link.now }] as const)),
    ],
    { ...link.set, updatedAt: link.now },
  );
  return n > 0 ? ok(organization) : fail("unauthorized");
}
