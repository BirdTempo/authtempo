import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDomainRecord } from "../src/compat.js";
import { carryDomainRecord, type DomainRecordOf } from "../src/compat-seams.js";
import { createOrganization } from "../src/engine/organizations.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { addDomain } from "../src/engine/sso/domains.js";
import {
  addSetupDomain,
  createPendingScimToken,
  readSetupDraft,
  SETUP_DRAFT_PER_LINK,
  type SetupConnectionInput,
  saveDraftConnection,
  setupActorName,
  verifySetupDomain,
} from "../src/engine/sso/setup-drafts.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SetupStep } from "../src/schema.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { recordAddress, recordCredential } from "./helpers.js";
import { scimAuth } from "./scim/helpers.js";
import { SSO_APP } from "./sso/helpers.js";

const HOUR_MS = 3_600_000;
const META = { ip: recordAddress("198.51.100.9"), userAgent: "setup-drafts-test" };
/** What a caller gets with no credential. */
const UNAUTHORIZED = { ok: false, code: "unauthorized", status: 401 };
const SECRET = "idp-client-secret-0123456789";
const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: "https://login.idp.example/acme",
  clientId: "acme-client",
  clientSecret: SECRET,
} as const;

beforeEach(() => {
  // A refused step writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The world of `scimAuth` (organization acme, SCIM on) with SSO setup, OIDC, and SAML on. */
async function world() {
  return scimAuth({ sso: { oidc: true, saml: true, setup: {} } });
}
type W = Awaited<ReturnType<typeof world>>;

/** A setup session of the organization of `w`, through the real link, open, and check of the cookie. */
async function session(
  w: W,
  steps: SetupStep[] = ["domain", "connection", "directory"],
  kinds: ("oidc" | "saml")[] = ["oidc", "saml"],
  organizationId: string = w.org,
) {
  const made = await createSetupLink(w.config, SSO_APP, {
    organizationId,
    steps,
    kinds,
    note: "Ada at Acme IT",
  });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  const opened = await openSetupSession(w.config, made.value.token, META);
  if (!opened.ok) throw new Error(opened.code);
  const pair = opened.value.cookie.split(";")[0] ?? "";
  recordCredential(pair.split("=")[1] ?? "");
  const checked = await requireSetupSession(
    w.config,
    new Request("https://auth.example/auth/sso/setup/status", { headers: { cookie: pair } }),
  );
  if (!checked.ok) throw new Error(checked.code);
  return checked.value;
}

const connections = (w: W) => w.storage.findMany("ssoConnection", []);

describe("the steps and the kinds of the link", () => {
  it("refuses a connection write when the steps hold no connection", async () => {
    const w = await world();
    const s = await session(w, ["domain"]);
    expect(await saveDraftConnection(w.config, s, OIDC)).toEqual(UNAUTHORIZED);
    expect(await connections(w)).toEqual([]);
  });

  it("refuses a domain write and a token write by the same rule", async () => {
    const w = await world();
    const s = await session(w, ["connection"]);
    expect(await addSetupDomain(w.config, s, "acme.test")).toEqual(UNAUTHORIZED);
    expect(await createPendingScimToken(w.config, s)).toEqual(UNAUTHORIZED);
    expect(await w.storage.findMany("scimToken", [])).toEqual([]);
  });

  it("refuses a SAML draft when the kinds hold no SAML", async () => {
    const w = await world();
    const s = await session(w, ["connection"], ["oidc"]);
    const idp = await createTestIdp({ alg: "rsa" });
    const saml: SetupConnectionInput = {
      kind: "saml",
      label: "Acme SAML",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    };
    // The same input is a valid SAML connection for a link that holds SAML.
    const both = await session(w);
    expect(await saveDraftConnection(w.config, both, saml)).toMatchObject({ ok: true });
    const r = await saveDraftConnection(w.config, s, saml);
    expect(r).toMatchObject({ ok: false, code: "invalid_body", status: 400 });
    expect(JSON.stringify(r)).toContain("kind");
    expect(await w.storage.findMany("ssoConnection", [])).toHaveLength(1);
  });
});

describe("the draft connection", () => {
  it("writes an inert draft of the link with version 1", async () => {
    const w = await world();
    const s = await session(w);
    const r = await saveDraftConnection(w.config, s, OIDC);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(r.value).toMatchObject({ enabled: false, draft: true, organizationId: w.org });
    const rows = await connections(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      enabled: false,
      draft: true,
      version: 1,
      setupLinkId: s.link.id,
      organizationId: w.org,
    });
  });

  it("adds 1 to the version once for one change, and keeps one row", async () => {
    const w = await world();
    const s = await session(w);
    await saveDraftConnection(w.config, s, OIDC);
    w.clock.advance(1000);
    const second = await saveDraftConnection(w.config, s, { ...OIDC, label: "Acme Okta 2" });
    if (!second.ok) throw new Error(second.code);
    const rows = await connections(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "Acme Okta 2",
      version: 2,
      draft: true,
      enabled: false,
    });
    expect(second.value.id).toBe(rows[0]?.id);
    w.clock.advance(1000);
    await saveDraftConnection(w.config, s, { ...OIDC, label: "Acme Okta 3" });
    expect((await connections(w))[0]?.version).toBe(3);
  });

  it("makes no second draft of a link when two creates meet", async () => {
    const w = await world();
    const s = await session(w);
    const input = { organizationId: w.org, ...OIDC };
    const actor = { kind: "app", name: setupActorName(s.link.id) } as const;
    const first = await createConnection(w.config, actor, input, {}, s.link.id);
    const second = await createConnection(
      w.config,
      actor,
      { ...input, label: "Two" },
      {},
      s.link.id,
    );
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "conflict" });
    expect(await connections(w)).toHaveLength(1);
  });

  it("refuses the owner fields: enabled, jit, defaultRole, mfa, scimRoles", async () => {
    const w = await world();
    const s = await session(w);
    for (const extra of [
      { enabled: true },
      { jit: false },
      { defaultRole: "admin" },
      { mfa: null },
      { scimRoles: {} },
      { organizationId: "org_other" },
    ]) {
      const r = await saveDraftConnection(w.config, s, { ...OIDC, ...extra } as never);
      expect(r).toMatchObject({ ok: false, code: "invalid_body" });
    }
    expect(await connections(w)).toEqual([]);
  });

  it("gives the refusal of POST /sso/connections/create for a private host and an XML bomb", async () => {
    const w = await world();
    const s = await session(w);
    const cases = [
      { ...OIDC, issuer: "https://10.0.0.5/acme" },
      {
        kind: "saml",
        label: "Bomb",
        idpMetadata: '<!DOCTYPE a [<!ENTITY b "c">]><EntityDescriptor>&b;</EntityDescriptor>',
      },
      {
        kind: "saml",
        label: "Private",
        idpEntityId: "https://idp.example/metadata",
        ssoUrl: "https://192.168.1.10/sso",
        certificates: [],
      },
    ] as const;
    for (const input of cases) {
      const setup = await saveDraftConnection(w.config, s, input as never);
      const manager = await createConnection(w.config, SSO_APP, {
        organizationId: w.org,
        ...input,
      } as never);
      expect(setup.ok).toBe(false);
      expect(setup).toEqual(manager);
    }
    expect(await connections(w)).toEqual([]);
  });

  it("seals the secret and shows it nowhere", async () => {
    const w = await world();
    const s = await session(w);
    const saved = await saveDraftConnection(w.config, s, OIDC);
    const read = await readSetupDraft(w.config, s);
    const row = (await connections(w))[0];
    expect(JSON.stringify([saved, read])).not.toContain(SECRET);
    expect(JSON.stringify([saved, read])).not.toContain("clientSecret");
    expect(row?.clientSecret).toBeTruthy();
    expect(row?.clientSecret).not.toContain(SECRET);
  });

  it("reads no live connection of the organization", async () => {
    const w = await world();
    const live = await createConnection(w.config, SSO_APP, { organizationId: w.org, ...OIDC });
    if (!live.ok) throw new Error(live.code);
    const s = await session(w);
    expect(await readSetupDraft(w.config, s)).toEqual({ ok: true, value: null });
    const saved = await saveDraftConnection(w.config, s, { ...OIDC, label: "Draft" });
    if (!saved.ok) throw new Error(saved.code);
    const read = await readSetupDraft(w.config, s);
    expect(read).toMatchObject({ ok: true, value: { id: saved.value.id, label: "Draft" } });
    // After an activation the row keeps the link id and has no draft mark: it is live, and no read of the link.
    await w.storage.update("ssoConnection", [{ field: "id", op: "eq", value: saved.value.id }], {
      draft: false,
      enabled: true,
    });
    expect(await readSetupDraft(w.config, s)).toEqual({ ok: true, value: null });
    // The live row stays as it was.
    const rows = await connections(w);
    expect(rows.find((r) => r.id === live.value.id)).toMatchObject({ enabled: true, draft: false });
  });

  it("does not touch a draft of another link of the same organization", async () => {
    const w = await world();
    const a = await session(w);
    const b = await session(w);
    await saveDraftConnection(w.config, a, OIDC);
    await saveDraftConnection(w.config, b, { ...OIDC, label: "Second" });
    expect(await connections(w)).toHaveLength(2);
    expect(await readSetupDraft(w.config, b)).toMatchObject({ value: { label: "Second" } });
  });

  it("refuses a label of the provider id form only when a compat package is on", async () => {
    const w = await world();
    const s = await session(w);
    expect(await saveDraftConnection(w.config, s, { ...OIDC, label: "acme" })).toMatchObject({
      ok: true,
    });
    const marked = await world();
    const record: DomainRecordOf = (row, label) =>
      label === null ? null : { name: `_ba-${label}.${row.domain}`, values: [row.challenge] };
    const input = {};
    withDomainRecord(input as never, record);
    carryDomainRecord(input, marked.config);
    const ms = await session(marked);
    expect(await saveDraftConnection(marked.config, ms, { ...OIDC, label: "acme" })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await connections(marked)).toEqual([]);
    // A label with a space is no provider id: it passes.
    expect(
      await saveDraftConnection(marked.config, ms, { ...OIDC, label: "Acme Okta" }),
    ).toMatchObject({ ok: true });
  });

  it("writes one audit row for each write, by the app actor of the link", async () => {
    const w = await world();
    const s = await session(w);
    await saveDraftConnection(w.config, s, OIDC);
    w.clock.advance(1000);
    await saveDraftConnection(w.config, s, { ...OIDC, label: "Two" });
    const rows = await w.storage.findMany("operatorAudit", []);
    const mine = rows.filter((r) => r.action.startsWith("sso_connection_"));
    expect(mine.map((r) => r.action).sort()).toEqual([
      "sso_connection_create",
      "sso_connection_update",
    ]);
    for (const r of mine)
      expect(r).toMatchObject({ actorKind: "app", actorId: setupActorName(s.link.id) });
    expect(setupActorName("01ABCXYZ")).toBe("setup.01abcxyz");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});

describe("the domains", () => {
  it("adds a domain with the link id and no route", async () => {
    const w = await world();
    const s = await session(w);
    const r = await addSetupDomain(w.config, s, "acme.test", META);
    if (!r.ok) throw new Error(r.code);
    const row = await w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: r.value.id },
    ]);
    expect(row).toMatchObject({
      domain: "acme.test",
      setupLinkId: s.link.id,
      connectionId: null,
      organizationId: w.org,
    });
  });

  it("verifies a pending domain and routes no connection", async () => {
    const w = await world();
    const s = await session(w);
    const added = await addSetupDomain(w.config, s, "acme.test");
    if (!added.ok || added.value.record === null) throw new Error("no domain");
    const { name, value } = added.value.record;
    w.answers.a[name] = [value];
    w.answers.b[name] = [value];
    const r = await verifySetupDomain(w.config, s, added.value.id);
    if (!r.ok) throw new Error(r.code);
    const row = await w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: added.value.id },
    ]);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.connectionId).toBeNull();
    expect(row?.setupLinkId).toBe(s.link.id);
  });

  it("answers as for no credential for a domain of another organization", async () => {
    const w = await world();
    const owner2 = await w.seedUser("owner@other.example");
    const other = await createOrganization(w.config, {
      user: owner2,
      slug: "other",
      name: "Other",
    });
    if (!other.ok) throw new Error(other.code);
    const foreign = await addDomain(w.config, SSO_APP, {
      organizationId: other.value.organization.id,
      domain: "other.test",
    });
    if (!foreign.ok || foreign.value.record === null) throw new Error("no domain");
    w.answers.a[foreign.value.record.name] = [foreign.value.record.value];
    w.answers.b[foreign.value.record.name] = [foreign.value.record.value];
    const s = await session(w);
    expect(await verifySetupDomain(w.config, s, foreign.value.id)).toEqual(UNAUTHORIZED);
    expect(await verifySetupDomain(w.config, s, "no-such-id")).toEqual(UNAUTHORIZED);
    const row = await w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: foreign.value.id },
    ]);
    expect(row?.verifiedAt).toBeNull();
  });
});

describe("the pending SCIM token", () => {
  it("shows the token once and keeps one pending token for the link", async () => {
    const w = await world();
    const s = await session(w);
    const first = await createPendingScimToken(w.config, s, META);
    if (!first.ok) throw new Error(first.code);
    const second = await createPendingScimToken(w.config, s, META);
    if (!second.ok) throw new Error(second.code);
    expect(second.value.token).not.toBe(first.value.token);
    const rows = await w.storage.findMany("scimToken", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pending: true,
      setupLinkId: s.link.id,
      organizationId: w.org,
      tokenHash: await sha256Hex(second.value.token),
    });
    expect(JSON.stringify(rows)).not.toContain(second.value.token);
  });

  it("keeps a token of another link and a live token of the organization", async () => {
    const w = await world();
    const a = await session(w);
    const b = await session(w);
    await createPendingScimToken(w.config, a);
    await createPendingScimToken(w.config, b);
    const rows = await w.storage.findMany("scimToken", []);
    expect(rows.map((r) => r.setupLinkId).sort()).toEqual([a.link.id, b.link.id].sort());
  });
});

describe("the limit of draft writes", () => {
  it("allows 60 writes of one link in an hour and refuses the 61st", async () => {
    expect(SETUP_DRAFT_PER_LINK).toEqual({ seconds: 3600, max: 60 });
    const w = await world();
    const s = await session(w);
    const other = await session(w);
    for (let i = 0; i < 60; i++) {
      const r = await addSetupDomain(w.config, s, "acme.test");
      expect(r.ok).toBe(true);
    }
    expect(await addSetupDomain(w.config, s, "acme.test")).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(await saveDraftConnection(w.config, s, OIDC)).toMatchObject({ code: "rate_limited" });
    expect(await connections(w)).toEqual([]);
    // The count is per link.
    expect(await addSetupDomain(w.config, other, "acme.test")).toMatchObject({ ok: true });
    w.clock.advance(HOUR_MS + 1000);
    expect(await addSetupDomain(w.config, s, "acme.test")).toMatchObject({ ok: true });
  });
});
