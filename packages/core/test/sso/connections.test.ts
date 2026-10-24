import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config.js";
import { createAuth } from "../../src/create-auth.js";
import { createOrganization, deleteOrganization } from "../../src/engine/organizations.js";
import { createRole } from "../../src/engine/roles.js";
import { rewrapSecrets, secretsStatus } from "../../src/engine/secrets.js";
import {
  connectionSecret,
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection,
} from "../../src/engine/sso/connections.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import { createRouter } from "../../src/http/router.js";
import { coreRoutes } from "../../src/http/routes/index.js";
import { sha256Hex } from "../../src/primitives/crypto.js";
import type { OperatorAuditRow, SsoConnectionRow } from "../../src/schema.js";
import type { StorageAdapter } from "../../src/storage/port.js";
import { createTestIdp } from "../../src/testing/saml-idp.js";
import { BASE_URL, post } from "../helpers.js";
import { FAST } from "../password-helpers.js";
import { verifiedSession } from "../totp-helpers.js";
import { SSO_APP, seedOrganization, ssoAuth, verifiedDomain } from "./helpers.js";

beforeEach(() => {
  // A refused write and a secret that does not open write one log line each; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = "the-client-secret-of-acme-0123456789";
/** The app secret of `makeAuth`, version 1. */
const V1 = "0123456789abcdef0123456789abcdef";
/** A second app secret for the rotation, 32 random-looking characters. */
const V2 = "Zq7Xw2Lp9Vt4Rk8Nc3Hm6Bf1Jd5Gs0Ya";

type SsoWorld = ReturnType<typeof ssoAuth>;

/** A memory engine with OIDC and SAML connections on. */
function connectionAuth(limits?: { connectionsPerOrganization: number }) {
  return ssoAuth({
    password: { hash: FAST, uniformSignUp: false },
    sso: { oidc: true, saml: true, ...(limits ? { limits } : {}) },
  });
}

/** The input of an OIDC connection of `organizationId` with discovery. */
function oidcInput(organizationId: string) {
  return {
    organizationId,
    kind: "oidc" as const,
    label: "Acme Entra ID",
    issuer: "https://login.idp.example/acme/v2.0",
    clientId: "acme-client",
    clientSecret: SECRET,
  };
}

/** An OIDC connection made by the app; each step must answer ok. */
async function oidcConnection(w: SsoWorld, organizationId: string) {
  const r = await createConnection(w.config, SSO_APP, oidcInput(organizationId));
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

async function rowOf(w: SsoWorld, id: string): Promise<SsoConnectionRow | null> {
  return w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: id }]);
}

async function auditOf(w: SsoWorld, action: OperatorAuditRow["action"]) {
  return w.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }], {
    sort: { field: "id", dir: "asc" },
  });
}

/** `invalid_body` with a message that holds `field`. */
function refusedFor(field: string) {
  return {
    ok: false,
    code: "invalid_body",
    status: 400,
    message: expect.stringContaining(field),
  };
}

/**
 * A storage whose transaction handle throws at an update of `model`. Every
 * other call goes to `storage`. It stands for a fault of the database at
 * that statement.
 */
function faultAt(storage: StorageAdapter, model: string): StorageAdapter {
  const guard = (tx: StorageAdapter): StorageAdapter =>
    new Proxy(tx, {
      get(target, key) {
        if (key === "update")
          return (m: string, ...rest: unknown[]) => {
            if (m === model) throw new Error("the fault of a test");
            return (target.update as (...a: unknown[]) => unknown)(m, ...rest);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(storage, {
    get(target, key) {
      if (key === "transaction")
        return <T>(fn: (tx: StorageAdapter) => Promise<T>) =>
          target.transaction((tx) => fn(guard(tx)));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the SSO connections (plan 12d Task 3)", () => {
  it("refuses a private host for the issuer and each endpoint", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const hosts = [
      "https://localhost",
      "https://10.0.0.1",
      "https://idp.internal",
      "https://intranet",
      // The host of baseURL: core would fetch itself.
      BASE_URL,
    ];
    const good = {
      authorizeUrl: "https://login.idp.example/authorize",
      tokenUrl: "https://login.idp.example/token",
      jwksUrl: "https://login.idp.example/keys",
    };
    for (const host of hosts) {
      expect(
        await createConnection(w.config, SSO_APP, { ...oidcInput(org), issuer: `${host}/v2.0` }),
        host,
      ).toEqual(refusedFor("issuer"));
      for (const key of ["authorizeUrl", "tokenUrl", "jwksUrl"] as const)
        expect(
          await createConnection(w.config, SSO_APP, {
            ...oidcInput(org),
            endpoints: { ...good, [key]: `${host}/${key}` },
          }),
          `${host} ${key}`,
        ).toEqual(refusedFor("endpoints"));
    }
    // An http endpoint is refused too; the public form passes.
    expect(
      await createConnection(w.config, SSO_APP, {
        ...oidcInput(org),
        endpoints: { ...good, tokenUrl: "http://login.idp.example/token" },
      }),
    ).toEqual(refusedFor("endpoints"));
    const r = await createConnection(w.config, SSO_APP, { ...oidcInput(org), endpoints: good });
    expect(r.ok && r.value.oidc?.endpoints).toEqual(good);
    expect(await w.storage.findMany("ssoConnection", [])).toHaveLength(1);
  });

  it("seals the client secret and never answers it", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const created = await oidcConnection(w, org);
    const row = await rowOf(w, created.id);
    if (!row?.clientSecret) throw new Error("no sealed secret");
    expect(row.clientSecret).not.toBe(SECRET);
    expect(row.secretVersion).toBe(1);
    const listed = await listConnections(w.config, SSO_APP, { organizationId: org });
    const audit = await auditOf(w, "sso_connection_create");
    expect(audit.map((a) => a.data)).toEqual([
      {
        organizationId: org,
        connectionId: created.id,
        kind: "oidc",
        changed: ["clientId", "clientSecret", "issuer", "label"],
      },
    ]);
    for (const text of [JSON.stringify(created), JSON.stringify(listed), JSON.stringify(audit)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(row.clientSecret);
    }
    expect(await connectionSecret(w.config, row)).toBe(SECRET);
    // The sealed value is bound to its row: a copy on another row does not open.
    expect(await connectionSecret(w.config, { ...row, id: "c-other" })).toBeNull();
  });

  it("opens a secret of an older version after a rotation", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const created = await oidcConnection(w, org);
    // The same database under 12b's two-version config: version 2 is current.
    const rotated = resolveConfig({
      baseURL: BASE_URL,
      secrets: [
        { version: 2, value: V2 },
        { version: 1, value: V1 },
      ],
      trustedOrigins: [],
      storage: w.storage,
      mail: { send: async () => {} },
      clock: w.clock,
      organizations: { ranks: { viewer: 1, member: 2, admin: 3, owner: 4 } },
      sso: { oidc: true, dns: w.config.sso?.dns ? [...w.config.sso.dns] : [] },
    });
    const before = await rowOf(w, created.id);
    if (!before) throw new Error("no row");
    expect(await connectionSecret(rotated, before)).toBe(SECRET);
    const updated = await updateConnection(rotated, SSO_APP, {
      id: created.id,
      clientSecret: "the-new-secret-0123456789",
    });
    expect(updated.ok).toBe(true);
    const after = await rowOf(w, created.id);
    if (!after) throw new Error("no row");
    expect(after.secretVersion).toBe(2);
    expect(await connectionSecret(rotated, after)).toBe("the-new-secret-0123456789");
    // Version 1 alone no longer opens it.
    expect(await connectionSecret(w.config, after)).toBeNull();
  });

  it("counts a client secret under its version until the rewrap moves it (ruling 31)", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const created = await oidcConnection(w, org);
    // A SAML connection seals no secret, so it adds no count.
    const idp = await createTestIdp({ alg: "ec" });
    const saml = await createConnection(w.config, SSO_APP, {
      organizationId: org,
      kind: "saml",
      label: "Acme Okta",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    });
    expect(saml.ok).toBe(true);
    const keyring = (secrets: { version: number; value: string }[]) =>
      resolveConfig({
        baseURL: BASE_URL,
        secrets,
        trustedOrigins: [],
        storage: w.storage,
        mail: { send: async () => {} },
        clock: w.clock,
        organizations: {},
        sso: { oidc: true, dns: w.config.sso?.dns ? [...w.config.sso.dns] : [] },
      });
    const rotated = keyring([
      { version: 2, value: V2 },
      { version: 1, value: V1 },
    ]);
    const countOf = async (version: number) =>
      (await secretsStatus(rotated)).versions.find((v) => v.version === version)?.ssoClientSecrets;
    const second = await oidcConnection(w, org);
    // Version 1 is not free: two client secrets are sealed under it.
    expect([await countOf(2), await countOf(1)]).toEqual([0, 2]);
    // A pass of one row leaves the other: `more` says so, and `next` names the cursor.
    const first = await rewrapSecrets(rotated, { limit: 1 });
    expect(first).toEqual({
      ok: true,
      value: {
        resealed: 1,
        failed: 0,
        skipped: 0,
        more: true,
        next: `ssoConnection:${[created.id, second.id].sort()[0]}`,
      },
    });
    expect([await countOf(2), await countOf(1)]).toEqual([1, 1]);
    const pass = await rewrapSecrets(rotated, {
      limit: 100,
      ...(first.ok && first.value.next ? { after: first.value.next } : {}),
    });
    expect(pass).toEqual({
      ok: true,
      value: { resealed: 1, failed: 0, skipped: 0, more: false, next: null },
    });
    expect([await countOf(2), await countOf(1)]).toEqual([2, 0]);
    // The reseal is no change for the lock of an update: updatedAt stays.
    const row = await rowOf(w, created.id);
    if (!row) throw new Error("no row");
    expect([row.secretVersion, row.updatedAt]).toEqual([2, new Date(created.updatedAt)]);
    // Version 1 leaves the config, and the secret still opens.
    expect(await connectionSecret(keyring([{ version: 2, value: V2 }]), row)).toBe(SECRET);
  });

  it("refuses owner and the platform role as a default role and in the role map", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    for (const role of ["owner", "operator", "admin,owner", "member,operator", "ghost"]) {
      expect(
        await createConnection(w.config, SSO_APP, { ...oidcInput(org), defaultRole: role }),
        role,
      ).toEqual(refusedFor("defaultRole"));
      expect(
        await createConnection(w.config, SSO_APP, {
          ...oidcInput(org),
          scimRoles: { Staff: "member", Leads: role },
        }),
        role,
      ).toEqual(refusedFor("scimRoles"));
    }
    expect(await w.storage.findMany("ssoConnection", [])).toEqual([]);
    const created = await oidcConnection(w, org);
    expect([created.defaultRole, created.scimRoles]).toEqual(["member", null]);
    expect(
      await updateConnection(w.config, SSO_APP, { id: created.id, defaultRole: "owner" }),
    ).toEqual(refusedFor("defaultRole"));
    expect(
      await updateConnection(w.config, SSO_APP, {
        id: created.id,
        scimRoles: { Admins: "operator" },
      }),
    ).toEqual(refusedFor("scimRoles"));
    const r = await updateConnection(w.config, SSO_APP, {
      id: created.id,
      defaultRole: "viewer",
      scimRoles: { Admins: "admin" },
    });
    expect(r.ok && [r.value.defaultRole, r.value.scimRoles]).toEqual([
      "viewer",
      { Admins: "admin" },
    ]);
  });

  it("refuses a platform role below the owner rank, and takes a dynamic role of the organization", async () => {
    // Here the platform role ranks below owner, so only the platform rule refuses it.
    const w = ssoAuth({
      organizations: {
        platformRole: "support",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, support: 3, admin: 4, owner: 5 },
        dynamicRoles: {},
      },
      sso: { oidc: true },
    });
    const org = await seedOrganization(w);
    const owner = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "owner@acme.example" },
    ]);
    if (!owner) throw new Error("no owner");
    for (const role of ["support", "viewer,support"]) {
      expect(
        await createConnection(w.config, SSO_APP, { ...oidcInput(org), defaultRole: role }),
        role,
      ).toEqual(refusedFor("defaultRole"));
      expect(
        await createConnection(w.config, SSO_APP, { ...oidcInput(org), scimRoles: { Ops: role } }),
        role,
      ).toEqual(refusedFor("scimRoles"));
    }
    // A dynamic role passes once the organization has its row.
    expect(
      await createConnection(w.config, SSO_APP, { ...oidcInput(org), defaultRole: "auditor" }),
    ).toEqual(refusedFor("defaultRole"));
    const made = await createRole(w.config, {
      user: owner,
      organizationId: org,
      name: "auditor",
      rank: 2,
      permissions: { member: ["read"] },
    });
    expect(made.ok).toBe(true);
    const r = await createConnection(w.config, SSO_APP, {
      ...oidcInput(org),
      defaultRole: "auditor",
      scimRoles: { Audit: "auditor", Staff: "member" },
    });
    expect(r.ok && [r.value.defaultRole, r.value.scimRoles]).toEqual([
      "auditor",
      { Audit: "auditor", Staff: "member" },
    ]);
  });

  it("stops at the connection limit", async () => {
    const w = connectionAuth({ connectionsPerOrganization: 2 });
    const org = await seedOrganization(w);
    await oidcConnection(w, org);
    await oidcConnection(w, org);
    expect(await createConnection(w.config, SSO_APP, oidcInput(org))).toEqual({
      ok: false,
      code: "connection_limit",
      status: 409,
    });
    // The limit counts per organization.
    const other = await seedOrganization(w, "other");
    expect((await createConnection(w.config, SSO_APP, oidcInput(other))).ok).toBe(true);
    expect(await auditOf(w, "sso_connection_create")).toHaveLength(3);
  });

  it("stops at the 11th connection under the default limit of 10 (ruling 88 F2)", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    for (let i = 0; i < 10; i++) await oidcConnection(w, org);
    expect(await createConnection(w.config, SSO_APP, oidcInput(org))).toEqual({
      ok: false,
      code: "connection_limit",
      status: 409,
    });
  });

  it("refuses an OIDC scope that does not hold openid (ruling 88 F5)", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    // The last three hold openid, with two spaces or a space at an end (RFC 6749 section 3.3).
    for (const scope of [
      "email profile",
      "openidx email",
      "OPENID",
      "openid  email",
      " openid",
      "openid ",
    ])
      expect(
        await createConnection(w.config, SSO_APP, { ...oidcInput(org), scope }),
        scope,
      ).toEqual(refusedFor("scope must hold openid"));
    const made = await createConnection(w.config, SSO_APP, {
      ...oidcInput(org),
      scope: "email openid profile",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect((await rowOf(w, made.value.id))?.config).toMatchObject({
      scope: "email openid profile",
    });
    expect(
      await updateConnection(w.config, SSO_APP, { id: made.value.id, scope: "email profile" }),
    ).toEqual(refusedFor("scope must hold openid"));
  });

  it("takes the enforce flag and the route off the domains of a deleted connection", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const connection = await oidcConnection(w, org);
    const domainId = await verifiedDomain(w, org);
    const routed = await updateDomain(w.config, SSO_APP, {
      id: domainId,
      connectionId: connection.id,
      enforce: true,
    });
    expect(routed.ok && [routed.value.connectionId, routed.value.enforce]).toEqual([
      connection.id,
      true,
    ]);
    const domainRow = () =>
      w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: domainId }]);
    const before = await domainRow();
    // A fault on the second statement, the update of the domains, leaves both rows as before.
    const faulty = { ...w.config, storage: faultAt(w.storage, "ssoDomain") };
    await expect(deleteConnection(faulty, SSO_APP, { id: connection.id })).rejects.toThrow(
      "the fault of a test",
    );
    expect(await rowOf(w, connection.id)).not.toBeNull();
    expect(await domainRow()).toEqual(before);
    expect(await auditOf(w, "sso_connection_delete")).toEqual([]);
    expect(await deleteConnection(w.config, SSO_APP, { id: connection.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await rowOf(w, connection.id)).toBeNull();
    expect(await domainRow()).toMatchObject({
      connectionId: null,
      enforce: false,
      verifiedAt: expect.any(Date),
    });
    expect((await auditOf(w, "sso_connection_delete")).map((a) => a.data)).toEqual([
      { organizationId: org, connectionId: connection.id, kind: "oidc", changed: [] },
    ]);
    expect(await deleteConnection(w.config, SSO_APP, { id: connection.id })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("refuses to turn off a connection that an enforced domain routes to", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const connection = await oidcConnection(w, org);
    const domainId = await verifiedDomain(w, org);
    const routed = await updateDomain(w.config, SSO_APP, {
      id: domainId,
      connectionId: connection.id,
      enforce: true,
    });
    expect(routed.ok).toBe(true);
    expect(
      await updateConnection(w.config, SSO_APP, { id: connection.id, enabled: false }),
    ).toEqual(refusedFor("enforce"));
    expect((await rowOf(w, connection.id))?.enabled).toBe(true);
    expect(await auditOf(w, "sso_connection_update")).toEqual([]);
    // With enforce off, the owner turns the connection off.
    expect((await updateDomain(w.config, SSO_APP, { id: domainId, enforce: false })).ok).toBe(true);
    const off = await updateConnection(w.config, SSO_APP, { id: connection.id, enabled: false });
    expect(off.ok && off.value.enabled).toBe(false);
    expect((await auditOf(w, "sso_connection_update")).map((a) => a.data?.changed)).toEqual([
      ["enabled"],
    ]);
  });

  it("creates a SAML connection from its fields, and refuses a text that is not IdP metadata", async () => {
    const idp = await createTestIdp({ alg: "ec", entityId: "https://idp.example/metadata" });
    const off = ssoAuth({ sso: { oidc: true } });
    const offOrg = await seedOrganization(off);
    const input = (organizationId: string) => ({
      organizationId,
      kind: "saml" as const,
      label: "Acme Okta",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    });
    // A kind that is off answers not_found, as a route of a feature that is off.
    expect(await createConnection(off.config, SSO_APP, input(offOrg))).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    const w = connectionAuth();
    const org = await seedOrganization(w);
    expect(
      await createConnection(w.config, SSO_APP, {
        organizationId: org,
        kind: "saml",
        label: "Acme Okta",
        idpMetadata: "<EntityDescriptor/>",
      }),
    ).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
      // Task 8 reads the metadata: an element with no namespace is no EntityDescriptor.
      message: "idpMetadata holds one EntityDescriptor",
    });
    const pem = idp.certificatePem;
    for (const certificates of [[], [pem, pem, pem], ["not a certificate"]])
      expect(await createConnection(w.config, SSO_APP, { ...input(org), certificates })).toEqual(
        refusedFor("certificates"),
      );
    expect(
      await createConnection(w.config, SSO_APP, { ...input(org), ssoUrl: "https://intranet/sso" }),
    ).toEqual(refusedFor("ssoUrl"));
    // An OIDC field on a SAML connection is refused by its name.
    expect(
      await createConnection(w.config, SSO_APP, { ...input(org), issuer: "https://idp.example" }),
    ).toEqual(refusedFor("issuer"));
    const r = await createConnection(w.config, SSO_APP, input(org));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.oidc).toBeUndefined();
    expect(r.value.saml).toEqual({
      idpEntityId: "https://idp.example/metadata",
      ssoUrl: "https://idp.example/sso",
      certificates: [{ notAfter: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }],
      subjectAttribute: null,
      attributes: { email: "email", name: null },
      spEntityId: `${BASE_URL}/auth/sso/${r.value.id}/metadata`,
      acsUrl: `${BASE_URL}/auth/sso/${r.value.id}/acs`,
    });
    // A SAML row seals no secret, and still writes the version (ruling 26 Q1).
    const row = await rowOf(w, r.value.id);
    expect([row?.clientSecret, row?.secretVersion]).toEqual([null, 1]);
    expect(await updateConnection(w.config, SSO_APP, { id: r.value.id, kind: "oidc" })).toEqual(
      refusedFor("kind"),
    );
  });

  it("deletes the connections with the organization and with the account (ruling 30)", async () => {
    const w = connectionAuth();
    const handle = createRouter(w.config, coreRoutes(w.config));
    const orgId = await seedOrganization(w);
    const byOrg = await oidcConnection(w, orgId);
    const owner = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "owner@acme.example" },
    ]);
    if (!owner) throw new Error("no owner");
    expect((await deleteOrganization(w.config, { user: owner, organizationId: orgId })).ok).toBe(
      true,
    );
    expect(await rowOf(w, byOrg.id)).toBeNull();
    // A user who alone holds an organization deletes the account: the organization goes with its connections.
    const ada = await verifiedSession(w, "ada@example.com");
    const solo = await createOrganization(w.config, { user: ada.user, slug: "solo", name: "Solo" });
    if (!solo.ok) throw new Error(solo.code);
    const byAccount = await oidcConnection(w, solo.value.organization.id);
    const res = await handle(
      post("/auth/user/delete", {}, { cookie: `__Host-tempo_session=${ada.token}` }),
    );
    expect(res.status).toBe(200);
    expect(await rowOf(w, byAccount.id)).toBeNull();
    expect(await w.storage.findMany("ssoConnection", [])).toEqual([]);
  });
});

/** The operator secret of the rewrap route calls. */
const OPERATOR = "operator-secret-0123456789abcdef-0123456789";

/**
 * The engine on the storage of `w` under versions 2 and 1, with the
 * operator routes on. `storage` replaces the storage of `w`, for a wrapper.
 */
async function rotatedAuth(w: SsoWorld, storage: StorageAdapter = w.storage) {
  return createAuth({
    baseURL: BASE_URL,
    secrets: [
      { version: 2, value: V2 },
      { version: 1, value: V1 },
    ],
    trustedOrigins: [],
    storage,
    mail: { send: async () => {} },
    clock: w.clock,
    organizations: {},
    operator: { secretHash: await sha256Hex(OPERATOR) },
    sso: {
      oidc: true,
      saml: true,
      dns: w.config.sso?.dns ? [...w.config.sso.dns] : [],
      limits: { connectionsPerOrganization: 50 },
    },
  });
}

/** 50 OIDC connections of one organization under version 1, each made by the app. */
async function fiftyConnections() {
  const w = connectionAuth({ connectionsPerOrganization: 50 });
  const org = await seedOrganization(w);
  for (let i = 0; i < 50; i++) await oidcConnection(w, org);
  return w;
}

/** A POST of the rewrap route with the operator secret and `body`. */
function rewrapRoute(body: Record<string, unknown>): Request {
  return new Request(`${BASE_URL}/auth/operator/secrets/rewrap`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": "203.0.113.7",
      authorization: `Operator ${OPERATOR}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("the rewrap of the SSO client secrets (ruling 34 of plan 12d)", () => {
  it("keeps a client secret that the owner writes between the read and the write of the rewrap", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const created = await oidcConnection(w, org);
    let between: (() => Promise<void>) | null = async () => {
      const r = await updateConnection(w.config, SSO_APP, {
        id: created.id,
        clientSecret: "the-owner-secret-0123456789",
      });
      if (!r.ok) throw new Error(r.code);
    };
    // The owner update runs once, right after the rewrap reads the connection rows.
    const storage = new Proxy(w.storage, {
      get(target, key) {
        if (key === "findMany")
          return async (model: string, ...rest: unknown[]) => {
            const rows = await (target.findMany as (...a: unknown[]) => Promise<unknown>)(
              model,
              ...rest,
            );
            const run = model === "ssoConnection" ? between : null;
            if (run) {
              between = null;
              await run();
            }
            return rows;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const auth = await rotatedAuth(w, storage);
    expect(await auth.api.secrets.rewrap({ limit: 100 })).toMatchObject({
      ok: true,
      value: { resealed: 0, failed: 1, skipped: 0 },
    });
    expect(between).toBeNull();
    const row = await rowOf(w, created.id);
    if (!row) throw new Error("no row");
    // The rewrap wrote nothing: the row holds the owner's new secret under version 1.
    expect(row.secretVersion).toBe(1);
    expect(await connectionSecret(w.config, row)).toBe("the-owner-secret-0123456789");
  });

  it("refuses a call budget below 50, above 1000, or not whole, through the api and the route", async () => {
    const w = await fiftyConnections();
    const auth = await rotatedAuth(w);
    for (const callBudget of [49, 1001, 50.5]) {
      expect(await auth.api.secrets.rewrap({ callBudget }), String(callBudget)).toEqual({
        ok: false,
        code: "invalid_body",
        status: 400,
      });
      const res = await auth.handle(rewrapRoute({ callBudget }));
      expect(res.status, String(callBudget)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    // No refused call moved a row.
    const rows = await w.storage.findMany("ssoConnection", []);
    expect(rows.map((r) => r.secretVersion)).toEqual(rows.map(() => 1));
  });

  it("reseals more rows in one api call with a budget above 50", async () => {
    const low = await fiftyConnections();
    // The memory storage has no counter, so each step counts its worst case.
    // The ready check, the three page reads, and the three end reads leave 43 rows of 50.
    expect(await (await rotatedAuth(low)).api.secrets.rewrap({ limit: 100 })).toMatchObject({
      ok: true,
      value: { resealed: 43, more: true },
    });
    const high = await fiftyConnections();
    expect(
      await (await rotatedAuth(high)).api.secrets.rewrap({ limit: 100, callBudget: 60 }),
    ).toMatchObject({ ok: true, value: { resealed: 50, more: false, next: null } });
  });

  it("passes the callBudget of the route body to the engine, and counts the route limiter", async () => {
    const low = await fiftyConnections();
    const lowRes = await (await rotatedAuth(low)).handle(rewrapRoute({ limit: 100 }));
    expect(lowRes.status).toBe(200);
    // The limiter call of the route takes one call of the 50: 42 rows, one less than the api.
    expect(await lowRes.json()).toMatchObject({ resealed: 42, more: true });
    const high = await fiftyConnections();
    const highRes = await (await rotatedAuth(high)).handle(
      rewrapRoute({ limit: 100, callBudget: 60 }),
    );
    expect(highRes.status).toBe(200);
    expect(await highRes.json()).toMatchObject({ resealed: 50, more: false, next: null });
  });
});

describe("the checks of a connection update and a certificate (ruling 34 of plan 12d)", () => {
  it("refuses an update that changes the organization of a connection", async () => {
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const other = await seedOrganization(w, "other");
    const created = await oidcConnection(w, org);
    expect(
      await updateConnection(w.config, SSO_APP, {
        id: created.id,
        organizationId: other,
        label: "Moved",
      }),
    ).toEqual(refusedFor("organizationId"));
    const row = await rowOf(w, created.id);
    expect([row?.organizationId, row?.label]).toEqual([org, "Acme Entra ID"]);
    // The same organization is no change, and the update passes.
    const same = await updateConnection(w.config, SSO_APP, {
      id: created.id,
      organizationId: org,
      label: "Renamed",
    });
    expect(same.ok && same.value.label).toBe("Renamed");
  });

  it("takes a certificate of 16384 characters and refuses one of 16385", async () => {
    const idp = await createTestIdp({ alg: "ec" });
    const pem = idp.certificatePem;
    // Trailing line breaks keep the PEM readable, so only the bound can refuse it.
    const padded = (length: number) => pem + "\n".repeat(length - pem.length);
    const w = connectionAuth();
    const org = await seedOrganization(w);
    const input = (certificate: string) => ({
      organizationId: org,
      kind: "saml" as const,
      label: "Acme Okta",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [certificate],
    });
    expect((await createConnection(w.config, SSO_APP, input(padded(16 * 1024)))).ok).toBe(true);
    expect(await createConnection(w.config, SSO_APP, input(padded(16 * 1024 + 1)))).toEqual(
      refusedFor("certificates"),
    );
  });
});
