import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createConnection, updateConnection } from "../src/engine/sso/connections.js";
import { nextNotice, stageAt } from "../src/engine/sso/expiry.js";
import { requireSsoManager } from "../src/engine/sso/guard.js";
import { activateSetup } from "../src/engine/sso/setup-activate.js";
import { createPendingScimToken, saveDraftConnection } from "../src/engine/sso/setup-drafts.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { newId } from "../src/primitives/ids.js";
import { ok } from "../src/result.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { BASE_URL, recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { SSO_APP, ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";

/** A UTC day at midnight. */
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
/** The now and the start of the case table of plan 13b Task 9. */
const NOW = day("2027-01-01");

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the next notice and the stage that is due (plan 13b Task 9)", () => {
  it.each([
    ["45 days", "2027-02-15", "2027-01-16", 30],
    ["20 days", "2027-01-21", "2027-01-14", 7],
    ["link 168 h", "2027-01-08", "2027-01-07", 1],
  ] as const)("%s: the end %s gives the notice %s of stage %i", (_row, end, notice, stage) => {
    expect(nextNotice(day(end), null, NOW, NOW)).toEqual(day(notice));
    // At the time of the notice, its stage is the one that is due.
    expect(stageAt(day(end), null, day(notice), NOW)).toBe(stage);
  });

  it.each([
    ["link 24 h", "2027-01-02"],
    ["past", "2026-12-01"],
  ] as const)("%s: the end %s gives no notice", (_row, end) => {
    expect(nextNotice(day(end), null, NOW, NOW)).toBeNull();
  });

  it("skip: a sweep that runs late sends the smallest stage that is due, not each one", () => {
    expect(
      stageAt(day("2027-02-15"), null, new Date("2027-02-14T12:00:00.000Z"), day("2027-01-01")),
    ).toBe(1);
  });

  it("after 30: the stage after a sent stage 30 is stage 7", () => {
    expect(nextNotice(day("2027-02-15"), 30, NOW, NOW)).toEqual(day("2027-02-08"));
  });

  it("gives no notice and no stage for no end, or before the first date", () => {
    expect(nextNotice(null, null, NOW, NOW)).toBeNull();
    expect(stageAt(day("2027-02-15"), null, NOW, NOW)).toBeNull();
  });
});

/** An engine with OIDC, SAML, the setup links, SCIM, and an owner of acme who passes the guard. */
async function world() {
  const w = ssoAuth({
    sso: { oidc: true, saml: true, setup: {} } as SsoConfig,
    scim: {},
    password: { hash: FAST, uniformSignUp: false },
  });
  const owner = await managerSession(w, "owner@acme.example", "acme");
  const resolved = await resolveSession(w.config, owner.token);
  if (!resolved) throw new Error("the session ended");
  const guard = await requireSsoManager(w.config, resolved, owner.org);
  if (!guard.ok) throw new Error(guard.code);
  return { w, org: owner.org, actor: guard.value };
}
type World = Awaited<ReturnType<typeof world>>;

const rowOf = async (x: World, id: string) => {
  const row = await x.w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: id }]);
  if (!row) throw new Error("no row");
  return row;
};

const expiryOf = async (x: World, id: string) => {
  const r = await rowOf(x, id);
  return {
    certificateEndsAt: r.certificateEndsAt,
    expiryStage: r.expiryStage,
    expiryNoticeAt: r.expiryNoticeAt,
  };
};

describe("the certificate end at each write of the certificates (plan 13b Task 9)", () => {
  it("rotation: a create stores the latest end of two certificates", async () => {
    const x = await world();
    const now = x.w.clock.now();
    const old = await createTestIdp({ alg: "rsa", certificateNotAfter: day("2027-03-01") });
    const next = await createTestIdp({ alg: "rsa", certificateNotAfter: day("2028-03-01") });
    const made = await createConnection(x.w.config, SSO_APP, {
      organizationId: x.org,
      kind: "saml",
      label: "Acme SAML",
      idpEntityId: old.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [old.certificatePem, next.certificatePem],
    });
    if (!made.ok) throw new Error(made.code);
    expect(await expiryOf(x, made.value.id)).toEqual({
      certificateEndsAt: day("2028-03-01"),
      expiryStage: null,
      expiryNoticeAt: nextNotice(day("2028-03-01"), null, now, now),
    });
    // The notice of stage 30 of the later end: 2028 is a leap year.
    expect((await rowOf(x, made.value.id)).expiryNoticeAt).toEqual(day("2028-01-31"));
  });

  it("gives an OIDC connection no certificate end and no notice", async () => {
    const x = await world();
    const made = await createConnection(x.w.config, SSO_APP, {
      organizationId: x.org,
      kind: "oidc",
      label: "Acme OIDC",
      issuer: "https://login.idp.example/acme",
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
    });
    if (!made.ok) throw new Error(made.code);
    expect(await expiryOf(x, made.value.id)).toEqual({
      certificateEndsAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
    });
  });

  it("new certificate: an update of the certificates clears the stage and sets a new notice", async () => {
    const x = await world();
    const first = await createTestIdp({ alg: "rsa", certificateNotAfter: day("2027-03-01") });
    const made = await createConnection(x.w.config, SSO_APP, {
      organizationId: x.org,
      kind: "saml",
      label: "Acme SAML",
      idpEntityId: first.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [first.certificatePem],
    });
    if (!made.ok) throw new Error(made.code);
    const id = made.value.id;
    // The sweep of Task 10 sent the notice of stage 7 and set the next one.
    await x.w.storage.update("ssoConnection", [{ field: "id", op: "eq", value: id }], {
      expiryStage: 7,
      expiryNoticeAt: day("2027-02-28"),
    });
    // A change of another field keeps the stage and the notice.
    const renamed = await updateConnection(x.w.config, SSO_APP, { id, label: "Acme SAML 2" });
    if (!renamed.ok) throw new Error(renamed.code);
    expect(await expiryOf(x, id)).toEqual({
      certificateEndsAt: day("2027-03-01"),
      expiryStage: 7,
      expiryNoticeAt: day("2027-02-28"),
    });
    const fresh = await createTestIdp({ alg: "rsa", certificateNotAfter: day("2029-06-01") });
    const changed = await updateConnection(x.w.config, SSO_APP, {
      id,
      certificates: [fresh.certificatePem],
    });
    if (!changed.ok) throw new Error(changed.code);
    expect(await expiryOf(x, id)).toEqual({
      certificateEndsAt: day("2029-06-01"),
      expiryStage: null,
      expiryNoticeAt: day("2029-05-02"),
    });
  });
});

describe("the expiry of a draft, a pending token, and a setup link (plan 13b Task 9)", () => {
  it("draft: a setup draft keeps no notice; the activation sets it", async () => {
    const x = await world();
    const made = await createSetupLink(x.w.config, x.actor, {
      organizationId: x.org,
      steps: ["connection", "directory"],
      kinds: ["oidc", "saml"],
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const opened = await openSetupSession(x.w.config, made.value.token, {
      ip: "198.51.100.9",
      userAgent: "expiry-test",
    });
    if (!opened.ok) throw new Error(opened.code);
    const cookie = opened.value.cookie.split(";")[0] ?? "";
    recordCredential(cookie.split("=")[1] ?? "");
    const checked = await requireSetupSession(
      x.w.config,
      new Request(`${BASE_URL}/auth/sso/setup/status`, { headers: { cookie } }),
    );
    if (!checked.ok) throw new Error(checked.code);
    const idp = await createTestIdp({ alg: "rsa", certificateNotAfter: day("2027-03-01") });
    const saved = await saveDraftConnection(x.w.config, checked.value, {
      kind: "saml",
      label: "Acme SAML",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    });
    if (!saved.ok) throw new Error(saved.code);
    const token = await createPendingScimToken(x.w.config, checked.value);
    if (!token.ok) throw new Error(token.code);
    recordCredential(token.value.token);
    const id = saved.value.id;
    expect(await expiryOf(x, id)).toEqual({
      certificateEndsAt: day("2027-03-01"),
      expiryStage: null,
      expiryNoticeAt: null,
    });
    const pending = await x.w.storage.findOne("scimToken", [
      { field: "id", op: "eq", value: token.value.id },
    ]);
    expect(pending?.expiryNoticeAt).toBeNull();
    // The setup page shows the end of the certificate of the draft.
    const page = await x.w.handle(
      new Request(`${BASE_URL}/auth/sso/setup/status?step=connect`, {
        headers: { cookie, "cf-connecting-ip": "198.51.100.9", "user-agent": "expiry-test" },
      }),
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(
      "<dt>Certificate ends</dt><dd><code>2027-03-01T00:00:00.000Z</code></dd>",
    );

    // A passed run of the draft, as the callback of a test run writes it.
    x.w.clock.advance(60_000);
    const now = x.w.clock.now();
    const draft = await rowOf(x, id);
    await x.w.storage.create("ssoTestRun", {
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      organizationId: x.org,
      connectionId: id,
      linkId: made.value.id,
      outcome: "passed",
      step: null,
      attributeNames: ["email"],
      domainClaimed: true,
      draftVersion: draft.version,
    });
    const live = await activateSetup(x.w.config, x.actor, made.value.id, draft.version, async () =>
      ok(undefined),
    );
    if (!live.ok) throw new Error(live.code);
    expect(await expiryOf(x, id)).toEqual({
      certificateEndsAt: day("2027-03-01"),
      expiryStage: null,
      expiryNoticeAt: day("2027-01-30"),
    });
  });

  it("gives a setup link of 168 hours the notice of stage 1, and a link of 24 hours none", async () => {
    const x = await world();
    const mint = async (ttlHours: number) => {
      const made = await createSetupLink(x.w.config, x.actor, {
        organizationId: x.org,
        steps: ["connection"],
        kinds: ["saml"],
        note: "Ada at Acme IT",
        ttlHours,
      });
      if (!made.ok) throw new Error(made.code);
      recordCredential(made.value.token);
      return x.w.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: made.value.id }]);
    };
    const now = x.w.clock.now();
    const week = await mint(168);
    expect([week?.expiryStage, week?.expiryNoticeAt]).toEqual([
      null,
      new Date(now.getTime() + 6 * 86_400_000),
    ]);
    const short = await mint(24);
    expect([short?.expiryStage, short?.expiryNoticeAt]).toEqual([null, null]);
  });

  it("gives a SCIM token with an end its first notice at the create, and a token with no end none", async () => {
    const x = await world();
    const now = x.w.clock.now();
    const mint = async (expiresInDays?: number) => {
      const made = await createScimToken(x.w.config, SSO_APP, {
        organizationId: x.org,
        name: "directory",
        ...(expiresInDays === undefined ? {} : { expiresInDays }),
      });
      if (!made.ok) throw new Error(made.code);
      recordCredential(made.value.token);
      return x.w.storage.findOne("scimToken", [{ field: "id", op: "eq", value: made.value.id }]);
    };
    const dated = await mint(45);
    expect([dated?.expiryStage, dated?.expiryNoticeAt]).toEqual([
      null,
      new Date(now.getTime() + 15 * 86_400_000),
    ]);
    const open = await mint();
    expect([open?.expiryStage, open?.expiryNoticeAt]).toEqual([null, null]);
  });
});
