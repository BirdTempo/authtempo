import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SsoConfig } from "../../core/src/config.js";
import { createOrganization, deleteOrganization } from "../../core/src/engine/organizations.js";
import { addSetupDomain, saveDraftConnection } from "../../core/src/engine/sso/setup-drafts.js";
import { createSetupLink } from "../../core/src/engine/sso/setup-links.js";
import {
  openSetupSession,
  requireSetupSession,
  type SetupSession,
} from "../../core/src/engine/sso/setup-session.js";
import { startTestRun } from "../../core/src/engine/sso/test-run.js";
import { newId } from "../../core/src/primitives/ids.js";
import { recordAddress, recordCredential } from "../../core/test/helpers.js";
import { FAST } from "../../core/test/password-helpers.js";
import { ssoAuth } from "../../core/test/sso/helpers.js";
import { endpointsOf, issuerOf } from "../../core/test/sso/sign-in-helpers.js";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// A setup write beside an organization delete, on the real Postgres adapter
// (ruling R22 of plan 13a). The delete locks the organization row, and then
// deletes the setup links and the setup sessions. Each setup write locks the
// organization row first, then the link row, then the session rows
// (`lockSetupRows` in setup-live.ts). So a setup write that starts while the
// delete holds the organization row waits for the commit of the delete. The
// reverse order made a deadlock (40P01): the setup write held the link row
// and waited on the organization row, and the delete held the organization
// row and waited on the link row. The caller then got a 500. Each state comes
// from the engine: the organization create, the link mint, and the open.
//
// The test start of plan 13a Task 7 takes the link row, then the run rows.
// The delete takes the run rows after the link, so the old order made no
// deadlock there. But the start held no organization row: it wrote a run and
// answered the IdP redirect for an organization that the delete removed.

const APP = { kind: "app", name: "support-tool" } as const;
/** The pause of the delete while it holds the organization row. */
const HOLD_MS = 800;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The engine on Postgres with the setup links on. `probe.hold` runs once in
 * the `beforeDelete` hook of the organization delete. The delete holds the
 * organization row there.
 */
function world() {
  const probe: { hold: (() => Promise<void>) | null } = { hold: null };
  const w = ssoAuth({
    storage: createPostgresAdapter(db.sql),
    sso: { oidc: true, setup: {} } as SsoConfig,
    password: { hash: FAST, uniformSignUp: false },
    hooks: {
      organization: {
        beforeDelete: async () => {
          const run = probe.hold;
          probe.hold = null;
          if (run) await run();
        },
      },
    },
  });
  /** An organization of a verified owner, and one live setup link of the organization. */
  async function scene() {
    const email = recordAddress("owner@acme.example");
    const now = w.config.clock.now();
    const user = await w.config.storage.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    const made = await createOrganization(w.config, { user, slug: "acme", name: "Acme" });
    if (!made.ok) throw new Error(made.code);
    const organizationId = made.value.organization.id;
    const link = await createSetupLink(w.config, APP, {
      organizationId,
      steps: ["domain", "connection"],
      kinds: ["oidc"],
      note: "Ada at Acme IT",
    });
    if (!link.ok) throw new Error(link.code);
    return { user, organizationId, token: recordCredential(link.value.token) };
  }
  /** The setup session of a new open of `token`, as the setup routes read it. */
  async function session(token: string): Promise<SetupSession> {
    const opened = await openSetupSession(w.config, token);
    if (!opened.ok) throw new Error(opened.code);
    const cookie = opened.value.cookie.split(";")[0] ?? "";
    const auth = await requireSetupSession(w.config, { headers: new Headers({ cookie }) });
    if (!auth.ok) throw new Error(auth.code);
    return auth.value;
  }
  return { ...w, probe, scene, session };
}

/** The count of the rows of each setup table and of the organization table. */
async function counts() {
  const [row] = await db.sql<
    { organizations: number; links: number; sessions: number; runs: number }[]
  >`
    SELECT (SELECT count(*)::int FROM ta_organization) AS organizations,
      (SELECT count(*)::int FROM ta_sso_setup_link) AS links,
      (SELECT count(*)::int FROM ta_sso_setup_session) AS sessions,
      (SELECT count(*)::int FROM ta_sso_test_run) AS runs`;
  return row;
}

/** No organization row, and no setup row of the deleted organization. */
const NONE = { organizations: 0, links: 0, sessions: 0, runs: 0 };

describe("a setup write beside an organization delete on Postgres (ruling R22 of plan 13a)", () => {
  it("refuses an open that waits on the delete, with no deadlock", async () => {
    const w = world();
    const s = await w.scene();
    let opening: Promise<unknown> | null = null;
    // 1: the delete holds the organization row. The open starts, and must wait on that row.
    w.probe.hold = async () => {
      opening = openSetupSession(w.config, s.token);
      opening.catch(() => {});
      await pause(HOLD_MS);
    };
    const deleted = await deleteOrganization(w.config, {
      user: s.user,
      organizationId: s.organizationId,
    });
    expect(deleted).toMatchObject({ ok: true });
    // The open locks the organization row after the commit of the delete, and finds no row.
    expect(await opening).toMatchObject({ ok: false, code: "setup_link_invalid" });
    expect(await counts()).toEqual(NONE);
  }, 60_000);

  it("refuses a draft write that waits on the delete, with no deadlock", async () => {
    const w = world();
    const s = await w.scene();
    const auth = await w.session(s.token);
    let adding: Promise<unknown> | null = null;
    // 1: the delete holds the organization row. The domain add of the link starts and waits.
    w.probe.hold = async () => {
      adding = addSetupDomain(w.config, auth, "acme.example");
      adding.catch(() => {});
      await pause(HOLD_MS);
    };
    const deleted = await deleteOrganization(w.config, {
      user: s.user,
      organizationId: s.organizationId,
    });
    expect(deleted).toMatchObject({ ok: true });
    // A setup write of a deleted organization answers as `requireSetupSession` does.
    expect(await adding).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await counts()).toEqual(NONE);
  }, 60_000);

  it("refuses a test start that waits on the delete (plan 13a Task 7)", async () => {
    const w = world();
    const s = await w.scene();
    const auth = await w.session(s.token);
    const draft = await saveDraftConnection(w.config, auth, {
      kind: "oidc",
      label: "Acme Okta",
      issuer: issuerOf("acme"),
      clientId: "acme-client",
      clientSecret: "idp-client-secret-0123456789",
      endpoints: endpointsOf("acme"),
    });
    if (!draft.ok) throw new Error(draft.code);
    let starting: Promise<unknown> | null = null;
    // 1: the delete holds the organization row. The test start of the draft starts and waits.
    w.probe.hold = async () => {
      starting = startTestRun(w.config, auth, draft.value.id, { ip: null, userAgent: null });
      starting.catch(() => {});
      await pause(HOLD_MS);
    };
    const deleted = await deleteOrganization(w.config, {
      user: s.user,
      organizationId: s.organizationId,
    });
    expect(deleted).toMatchObject({ ok: true });
    // The start locks the organization row after the commit of the delete: no run, no redirect.
    expect(await starting).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await counts()).toEqual(NONE);
  }, 60_000);
});
