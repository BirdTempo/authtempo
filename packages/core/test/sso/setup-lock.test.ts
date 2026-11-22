import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../../src/config.js";
import { deleteAccount } from "../../src/engine/account-delete.js";
import { createOrganization } from "../../src/engine/organizations.js";
import { addSetupDomain } from "../../src/engine/sso/setup-drafts.js";
import { createSetupLink } from "../../src/engine/sso/setup-links.js";
import { lockSetupRows } from "../../src/engine/sso/setup-live.js";
import { openSetupSession, requireSetupSession } from "../../src/engine/sso/setup-session.js";
import { recordCredential } from "../helpers.js";
import { type ScimWorld, scimAuth } from "../scim/helpers.js";

// The answers of `lockSetupRows` (ruling R22 of plan 13a). The helper locks
// the organization row before the link row. So an organization that is gone
// answers before the link: a setup write answers `unauthorized`, the answer
// of `requireSetupSession`. The order before R22 held the link first, and the
// same write answered `not_found`. The update of the link also holds the link
// in the organization that the caller names.

const APP = { kind: "app", name: "support-tool" } as const;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A live link of the organization `organizationId`. */
async function mint(w: ScimWorld, organizationId: string) {
  const made = await createSetupLink(w.config, APP, {
    organizationId,
    steps: ["domain"],
    kinds: ["oidc"],
    note: "Ada at Acme IT",
  });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  return made.value;
}

describe("the answers of lockSetupRows (ruling R22 of plan 13a)", () => {
  it("answers unauthorized to a draft write after the act of an account delete", async () => {
    const w = await scimAuth({ sso: { oidc: true, setup: {} } as SsoConfig });
    const link = await mint(w, w.org);
    const opened = await openSetupSession(w.config, link.token);
    if (!opened.ok) throw new Error(opened.code);
    const request = { headers: new Headers({ cookie: opened.value.cookie.split(";")[0] ?? "" }) };
    // The request passed its check before the act. The act deletes the organization row, and
    // the link waits for the sweep, so the link is still live at the write.
    const auth = await requireSetupSession(w.config, request);
    if (!auth.ok) throw new Error(auth.code);
    expect(await deleteAccount(w.config, { session: w.owner, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await w.storage.findMany("ssoSetupLink", [])).toHaveLength(1);
    expect(await addSetupDomain(w.config, auth.value, "beta.example")).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(
      await w.storage.findMany("ssoDomain", [{ field: "domain", op: "eq", value: "beta.example" }]),
    ).toEqual([]);
  });

  it("answers unauthorized to a link of another organization, and writes no link", async () => {
    const w = await scimAuth({ sso: { oidc: true, setup: {} } as SsoConfig });
    const other = await createOrganization(w.config, {
      user: w.owner.user,
      slug: "beta",
      name: "Beta",
    });
    if (!other.ok) throw new Error(other.code);
    const link = await mint(w, w.org);
    const now = w.config.clock.now();
    const held = await w.config.storage.transaction((tx) =>
      lockSetupRows(tx, other.value.organization.id, { id: link.id, now, set: { openedAt: now } }),
    );
    expect(held).toMatchObject({ ok: false, code: "unauthorized" });
    const row = await w.storage.findOne("ssoSetupLink", [
      { field: "id", op: "eq", value: link.id },
    ]);
    expect(row?.openedAt).toBeNull();
    // The same call with the organization of the link holds it.
    const own = await w.config.storage.transaction((tx) =>
      lockSetupRows(tx, w.org, { id: link.id, now, set: { openedAt: now } }),
    );
    expect(own).toMatchObject({ ok: true, value: { id: w.org } });
  });
});
