import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countSsoManageWrite,
  moveSsoManageCount,
  scimRequestAs,
  verifyDomainByRecord,
  withDomainRecord,
} from "../../src/compat.js";
import { carryDomainRecord, type DomainRecordOf, domainRecordFor } from "../../src/compat-seams.js";
import { createAuth } from "../../src/create-auth.js";
import { createConnection, updateConnection } from "../../src/engine/sso/connections.js";
import { addDomain, updateDomain, verifyDomainWith } from "../../src/engine/sso/domains.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { createRouter, type Route } from "../../src/http/router.js";
import { SSO_MANAGE_PER_USER } from "../../src/http/routes/sso.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { BASE_URL, get } from "../helpers.js";
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
 * With `marked` false, the config carries no record.
 */
async function recordWorld(marked = true) {
  const w = ssoAuth({ sso: { oidc: true } });
  if (marked) {
    const input = {};
    withDomainRecord(input as never, BA_RECORD);
    carryDomainRecord(input, w.config);
  }
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
  return { w, id: added.value.id, own: added.value.record, ba, connectionId: connection.value.id };
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
    // The domain is routed to a connection with a label, so only the missing mark refuses it.
    const { w, id, own, ba } = await recordWorld(false);
    for (const r of [own, ba]) {
      w.answers.a[r.name] = [r.value];
      w.answers.b[r.name] = [r.value];
    }
    expect(await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).toMatchObject({
      ok: false,
      code: "domain_unverified",
    });
    expect(w.a.calls).toEqual([]);
    // Core's own verify proves it, and the recheck asks for core's record only.
    expect((await verifyDomainWith(w.config, SSO_APP, { id }, "own")).ok).toBe(true);
    w.clock.advance(31 * DAY_MS);
    w.a.calls.length = 0;
    w.answers.a[own.name] = [];
    w.answers.b[own.name] = [];
    expect((await sweepExpired(w.config)).ssoDomains).toBe(1);
    expect(w.a.calls).toEqual([own.name]);
    const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
    expect(row).toMatchObject({ claimedDomain: "acme.example", failures: 1 });
  });

  it("takes a compat record of one DNS label under the domain only (review M1)", async () => {
    const { w, id, own, ba, connectionId } = await recordWorld();
    // Core's own route takes a dot in a label. The record then sits in the zone of sub.acme.example.
    const deep = { name: "_ba-x.sub.acme.example", value: ba.value };
    const relabel = async (label: string) => {
      const r = await updateConnection(w.config, SSO_APP, { id: connectionId, label });
      if (!r.ok) throw new Error(r.code);
    };
    await relabel("x.sub");
    w.answers.a[deep.name] = [deep.value];
    w.answers.b[deep.name] = [deep.value];
    expect(await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).toMatchObject({
      ok: false,
      code: "domain_unverified",
    });
    expect(w.a.calls).toEqual([]);
    // A claim that the record of the label "acme-sso" proved is not kept by the deeper name.
    await relabel("acme-sso");
    w.answers.a[ba.name] = [ba.value];
    w.answers.b[ba.name] = [ba.value];
    expect((await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).ok).toBe(true);
    await relabel("x.sub");
    w.answers.a[ba.name] = [];
    w.answers.b[ba.name] = [];
    w.clock.advance(31 * DAY_MS);
    w.a.calls.length = 0;
    expect((await sweepExpired(w.config)).ssoDomains).toBe(1);
    expect(w.a.calls).toEqual([own.name]);
    const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
    expect(row).toMatchObject({ claimedDomain: "acme.example", failures: 1 });
  });

  it("refuses a compat record name with a dot of another script (fix wave item 14)", async () => {
    const { w, id, connectionId } = await recordWorld();
    // IDNA maps U+3002, U+FF0E, and U+FF61 to a dot, so each one puts the record a zone deeper.
    for (const dot of ["\u3002", "\uff0e", "\uff61"]) {
      const r = await updateConnection(w.config, SSO_APP, {
        id: connectionId,
        label: `x${dot}sub`,
      });
      if (!r.ok) throw new Error(r.code);
      const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
      for (const name of [`_ba-x${dot}sub.acme.example`, "_ba-x.sub.acme.example"]) {
        w.answers.a[name] = [row?.challenge ?? ""];
        w.answers.b[name] = [row?.challenge ?? ""];
      }
      expect(await verifyDomainWith(w.config, SSO_APP, { id }, "compat")).toMatchObject({
        ok: false,
        code: "domain_unverified",
      });
      expect(w.a.calls, JSON.stringify(dot)).toEqual([]);
    }
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

  it("keeps the record on the config copy that the router gives each route (plan 12h)", async () => {
    const { w } = await recordWorld();
    // The router hands each handler a copy of the config with the observer of its request.
    const probe: Route = {
      method: "GET",
      path: "/probe",
      handler: async (ctx) =>
        new Response(domainRecordFor(ctx.config) === BA_RECORD ? "yes" : "no"),
    };
    const res = await createRouter(w.config, [probe])(get("/auth/probe"));
    expect(await res.text()).toBe("yes");
    expect(domainRecordFor({ ...w.config })).toBe(BA_RECORD);
  });

  it("gives an app config with a forged symbol of the same description core's record only (ruling 80)", async () => {
    const forged: DomainRecordOf = (row) => ({ name: `_forged.${row.domain}`, values: ["forged"] });
    const config = {
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { oidc: true as const, dns: [fakeDns("a", {})] },
      // A new symbol and a registered symbol, each of the description of core's key.
      [Symbol("authtempo.compat.domainRecord")]: forged,
      [Symbol.for("authtempo.compat.domainRecord")]: forged,
    };
    const verify = new Request(`${BASE_URL}/auth/sso/domains/verify`, { method: "POST" });
    // No withDomainRecord: the forged key is no record, so the seam refuses the Auth.
    expect(() => verifyDomainByRecord(createAuth(config), verify)).toThrow(TypeError);
    // A resolved config, or a copy, with the forged key holds no record either.
    const resolved = { ...ssoAuth().config, ...config };
    expect(domainRecordFor(resolved)).toBeNull();
    // With withDomainRecord, the record is the one of the compat entry, not the forged one.
    const input = { ...config };
    withDomainRecord(input as never, BA_RECORD);
    const w = ssoAuth({ sso: { oidc: true } });
    carryDomainRecord(input, w.config);
    expect(domainRecordFor({ ...w.config, ...config })).toBe(BA_RECORD);
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
    await expect(countSsoManageWrite({ ...plain }, scim, "u")).rejects.toThrow(TypeError);
  });

  it("counts a manager write that the compat package counted once, for its own user only (ruling 51 Minor 1)", async () => {
    const sent: string[] = [];
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async (m) => void sent.push(m.text) },
      organizations: {},
      sso: { oidc: true, dns: [fakeDns("a", {})] },
    });
    await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "");
    const session = await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    if (!session.ok || !("token" in session.value)) throw new Error("no session");
    const { token, user } = session.value as { token: string; user: { id: string } };
    // A manager write with no body to act on: core reads it and answers 400.
    const write = () =>
      new Request(`${BASE_URL}/auth/sso/connections/update`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
      });
    // Half the limit: a count of the package, then core's route, which counts no more.
    for (let i = 0; i < SSO_MANAGE_PER_USER.max / 2; i++) {
      const r = write();
      expect(await countSsoManageWrite(auth, r, user.id)).toBe(true);
      expect((await auth.handle(r)).status).toBe(400);
    }
    // A mark of another user counts again, and a move of no mark adds none.
    const other = write();
    expect(await countSsoManageWrite(auth, other, "someone-else")).toBe(true);
    const moved = write();
    moveSsoManageCount(write(), moved);
    for (const r of [other, moved]) expect((await auth.handle(r)).status).toBe(400);
    // So far: 15 writes, 1 count of the other user, and 2 counts of the user.
    let left = 0;
    while ((await auth.handle(write())).status === 400) left++;
    expect(left).toBe(SSO_MANAGE_PER_USER.max / 2 - 2);
    expect(await countSsoManageWrite(auth, write(), user.id)).toBe(false);
  });
});
