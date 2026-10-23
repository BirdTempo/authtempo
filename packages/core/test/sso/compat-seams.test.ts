import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scimRequestAs, verifyDomainByRecord, withDomainRecord } from "../../src/compat.js";
import { carryDomainRecord, type DomainRecordOf } from "../../src/compat-seams.js";
import { createAuth } from "../../src/create-auth.js";
import { createConnection } from "../../src/engine/sso/connections.js";
import { addDomain, updateDomain, verifyDomainWith } from "../../src/engine/sso/domains.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { BASE_URL } from "../helpers.js";
import { fakeDns, SSO_APP, seedOrganization, ssoAuth } from "./helpers.js";

// The seams of the compat entry (plan 12d Task 14, ruling 61 P3 and F4).
// The compat tests run them end to end through the Better Auth shim.

beforeEach(() => {
  // A refused proof writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A record of the form of Better Auth's: the label names the record, the challenge is the value. */
const BA_RECORD: DomainRecordOf = (row, label) =>
  label === null ? null : { name: `_ba-${label}.${row.domain}`, values: [row.challenge] };

/**
 * A world whose config carries `BA_RECORD`, as `createAuth` carries it from
 * `withDomainRecord`, and a domain routed to a connection labelled "acme-sso".
 */
async function recordWorld() {
  const w = ssoAuth({ sso: { oidc: true } });
  const input = {};
  withDomainRecord(input as never, BA_RECORD);
  carryDomainRecord(input, w.config);
  const organizationId = await seedOrganization(w);
  const connection = await createConnection(w.config, SSO_APP, {
    organizationId,
    kind: "oidc",
    label: "acme-sso",
    issuer: "https://login.idp.example/acme",
    clientId: "acme",
    clientSecret: "acme-secret-0123456789",
  });
  if (!connection.ok) throw new Error(connection.code);
  const added = await addDomain(w.config, SSO_APP, { organizationId, domain: "acme.example" });
  if (!added.ok || added.value.record === null) throw new Error("no domain");
  const routed = await updateDomain(w.config, SSO_APP, {
    id: added.value.id,
    connectionId: connection.value.id,
  });
  if (!routed.ok) throw new Error(routed.code);
  const row = await w.storage.findOne("ssoDomain", [
    { field: "id", op: "eq", value: added.value.id },
  ]);
  if (!row) throw new Error("no row");
  const ba = { name: "_ba-acme-sso.acme.example", value: row.challenge };
  return { w, id: added.value.id, own: added.value.record, ba };
}

describe("the compat seams of core (plan 12d Task 14)", () => {
  it("proves a domain by the compat record only on a compat verify", async () => {
    const { w, id, own, ba } = await recordWorld();
    w.answers.a[own.name] = [own.value];
    w.answers.b[own.name] = [own.value];
    // Core's own record does not count for a compat verify.
    expect(await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).toMatchObject({
      ok: false,
      code: "domain_unverified",
    });
    expect(w.a.calls.at(-1)).toBe(ba.name);
    w.answers.a[own.name] = [];
    w.answers.b[own.name] = [];
    w.answers.a[ba.name] = [ba.value];
    w.answers.b[ba.name] = [ba.value];
    // The compat record does not count for core's own verify.
    expect(await verifyDomainWith(w.config, SSO_APP, { id }, "own")).toMatchObject({
      ok: false,
      code: "domain_unverified",
    });
    expect(await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).toMatchObject({
      ok: true,
      value: { verified: true },
    });
  });

  it("answers domain_unverified to a compat verify on a config with no record", async () => {
    const w = ssoAuth();
    const added = await addDomain(w.config, SSO_APP, {
      organizationId: await seedOrganization(w),
      domain: "acme.example",
    });
    if (!added.ok || added.value.record === null) throw new Error("no domain");
    w.answers.a[added.value.record.name] = [added.value.record.value];
    w.answers.b[added.value.record.name] = [added.value.record.value];
    expect(
      await verifyDomainWith(w.config, SSO_APP, { id: added.value.id }, "compat"),
    ).toMatchObject({ ok: false, code: "domain_unverified" });
    expect(w.a.calls).toEqual([]);
  });

  it("keeps a claim that the compat record proved at the recheck (ruling 61 F4)", async () => {
    const { w, id, own, ba } = await recordWorld();
    w.answers.a[ba.name] = [ba.value];
    w.answers.b[ba.name] = [ba.value];
    expect((await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).ok).toBe(true);
    // 31 days later the recheck asks for the own record, then for the compat record.
    w.clock.advance(31 * DAY_MS);
    w.a.calls.length = 0;
    expect((await sweepExpired(w.config)).ssoDomains).toBe(1);
    expect(w.a.calls).toEqual([own.name, ba.name]);
    const kept = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
    expect(kept).toMatchObject({
      claimedDomain: "acme.example",
      failures: 0,
      checkedAt: w.clock.now(),
    });
    // With neither record, three failures over 72 hours lose the domain.
    w.answers.a[ba.name] = [];
    w.answers.b[ba.name] = [];
    w.clock.advance(31 * DAY_MS);
    for (const h of [0, 36, 36]) {
      w.clock.advance(h * HOUR_MS);
      await sweepExpired(w.config);
    }
    const lost = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
    expect(lost).toMatchObject({ claimedDomain: null, verifiedAt: null });
  });

  it("refuses each call outside the seams with a TypeError", async () => {
    const dns = fakeDns("a", {});
    const config = {
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { oidc: true as const, dns: [dns] },
      scim: {},
    };
    const plain = createAuth(config);
    const verify = (path: string, method = "POST") =>
      new Request(`${BASE_URL}/auth${path}`, { method });
    // A config with no record.
    expect(() => verifyDomainByRecord(plain, verify("/sso/domains/verify"))).toThrow(TypeError);
    const marked = createAuth(withDomainRecord({ ...config }, BA_RECORD));
    // Another path, another method, and an object that createAuth did not make.
    expect(() => verifyDomainByRecord(marked, verify("/sso/domains/add"))).toThrow(TypeError);
    expect(() => verifyDomainByRecord(marked, verify("/sso/domains/verify", "GET"))).toThrow(
      TypeError,
    );
    expect(() => verifyDomainByRecord({ ...marked }, verify("/sso/domains/verify"))).toThrow(
      TypeError,
    );
    const caller = { id: "dir:one", organizationId: "org-1", scopes: ["scim.users.read"] as const };
    const scim = new Request(`${BASE_URL}/auth/scim/v2/Users`);
    expect(() => scimRequestAs({ ...plain }, scim, caller)).toThrow(TypeError);
    expect(() => scimRequestAs(plain, new Request(`${BASE_URL}/auth/sso/domains`), caller)).toThrow(
      TypeError,
    );
    for (const bad of [
      { ...caller, id: "" },
      { ...caller, id: "x".repeat(129) },
      { ...caller, organizationId: "" },
      { ...caller, scopes: ["scim.users.admin"] as never },
    ])
      expect(() => scimRequestAs(plain, scim, bad), JSON.stringify(bad)).toThrow(TypeError);
  });
});
