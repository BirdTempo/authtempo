import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bodyCapOf,
  bodyClientOf,
  canManageSomeSso,
  checkSsoManager,
  countSsoLargeRead,
  countSsoManageWrite,
  moveSsoManageCount,
  readBodyText,
  scimRequestAs,
  verifyDomainByRecord,
  withDomainRecord,
} from "../../src/compat.js";
import {
  carryDomainRecord,
  type DomainRecordOf,
  domainRecordFor,
  takeSsoManagerChecked,
} from "../../src/compat-seams.js";
import type { AuthConfig } from "../../src/config.js";
import { createAuth } from "../../src/create-auth.js";
import type { ResolvedSession } from "../../src/engine/sessions.js";
import { createConnection, updateConnection } from "../../src/engine/sso/connections.js";
import { addDomain, updateDomain, verifyDomainWith } from "../../src/engine/sso/domains.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { ipBodyClient, LARGE_READ_SLOW_MS } from "../../src/http/body-cap.js";
import { createRouter, type Route } from "../../src/http/router.js";
import { SSO_LARGE_READ_PER_USER, SSO_MANAGE_PER_USER } from "../../src/http/routes/sso.js";
import { createMemoryLimiter } from "../../src/limiter/memory.js";
import type { LimiterPort } from "../../src/limiter/port.js";
import type { AuthEvent } from "../../src/observe/port.js";
import { base32Decode, totpCode } from "../../src/primitives/totp.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { BASE_URL, get, tokenFromMail } from "../helpers.js";
import { FAST } from "../password-helpers.js";
import { PASSWORD } from "../totp-helpers.js";
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

/**
 * A world of `createAuth` with a memory limiter and a clock of the test
 * (plan 12l). The limiter records each key that it counts in `keys`, so a
 * test reads which limits a call counted. The clock starts at the real time
 * and moves only by `clock.advance`. Each person comes through the flows of
 * the product: the password sign-up, the link of the verify mail, the
 * sign-in, `createOrganization`, and the TOTP setup and enable. `extra`
 * replaces a top key of the config.
 */
function seamWorld(extra: Partial<AuthConfig> = {}) {
  const sent: string[] = [];
  const keys: string[] = [];
  let now = Date.now();
  const clock = {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
  const memory = createMemoryLimiter(clock);
  const limiter: LimiterPort = {
    scope: "isolate",
    allow(key, window) {
      keys.push(key);
      return memory.allow(key, window);
    },
  };
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    limiter,
    clock,
    mail: { send: async (m) => void sent.push(m.text) },
    password: { hash: FAST },
    organizations: {},
    sso: { oidc: true, dns: [fakeDns("a", {})] },
    ...extra,
  });
  const { password, totp } = auth.api;
  if (!password || !totp) throw new Error("password and totp must be on");
  /** A user who signed up with a password and opened the link of the verify mail. */
  const verified = async (email: string): Promise<void> => {
    const up = await password.signUp({ email, password: PASSWORD, ip: null, userAgent: null });
    if (!up.ok) throw new Error(up.code);
    const token = tokenFromMail(sent.at(-1) ?? "");
    const proved = await password.verifyEmail({ token, ip: null, userAgent: null });
    if (!proved.ok) throw new Error(proved.code);
  };
  /** The session of a password sign-in now, with its token. The sign-in makes it fresh. */
  const signIn = async (email: string): Promise<ResolvedSession & { token: string }> => {
    const r = await password.signIn({ email, password: PASSWORD, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const session = await auth.api.getSession(r.value.token);
    if (!session) throw new Error("no session");
    return { ...session, token: r.value.token };
  };
  /** The id of an organization that the user of `session` creates as its owner. */
  const organization = async (session: ResolvedSession, slug: string): Promise<string> => {
    const made = await auth.api.createOrganization({ user: session.user, slug, name: slug });
    if (!made.ok) throw new Error(made.code);
    return made.value.organization.id;
  };
  /** TOTP on for the user of `session`, through the setup and the enable. */
  const enrol = async (session: ResolvedSession): Promise<void> => {
    const setup = await totp.setup({ userId: session.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    const code = await totpCode(base32Decode(setup.value.secret), clock.now());
    const enabled = await totp.enable({ session, code });
    if (!enabled.ok) throw new Error(enabled.code);
  };
  return { auth, memory, keys, clock, verified, signIn, organization, enrol };
}

/**
 * A world of `seamWorld` and a manager of `acme` with one OIDC connection
 * (plan 12l). The two connection writes run the guard before their body
 * read, so only a manager reaches their counts of the large read. The
 * manager is a verified user who created the organization through the api,
 * then turned on TOTP. The session of the sign-in before the enable is
 * fresh. Each step is a flow of the product.
 */
async function managerWorld(observe?: AuthConfig["observe"]) {
  const w = seamWorld(observe ? { observe } : {});
  const sso = w.auth.api.sso;
  if (!sso) throw new Error("sso must be on");
  await w.verified("ada@example.com");
  const session = await w.signIn("ada@example.com");
  const organizationId = await w.organization(session, "acme");
  await w.enrol(session);
  const connection = await sso.connections.create({
    actor: SSO_APP,
    organizationId,
    kind: "oidc",
    label: "acme-sso",
    issuer: "https://login.idp.example/acme",
    clientId: "acme",
    clientSecret: "acme-secret-0123456789",
  });
  if (!connection.ok) throw new Error(connection.code);
  return {
    auth: w.auth,
    limiter: w.memory,
    keys: w.keys,
    token: session.token,
    user: session.user,
    connectionId: connection.value.id,
  };
}

/**
 * The platform organization `platform-co` and the platform role `operator`
 * (plan 12f), with the user tools and impersonation on. The platform role
 * ranks below owner, so an operator who owns no organization is no owner.
 */
const PLATFORM: Partial<AuthConfig> = {
  organizations: {
    platformOrganization: "platform-co",
    platformRole: "operator",
    ranks: { viewer: 1, member: 2, operator: 2, admin: 3, owner: 4 },
  },
  operator: { users: true, impersonation: {} },
};

/**
 * A world of `seamWorld` with `PLATFORM` and four people (plan 12l), each
 * made through the flows of the product:
 *
 * - `ada`, a platform operator who owns no organization. The app makes the
 *   first operator, root@example.com, with `createAdmin`, and so the
 *   platform organization. A second `createAdmin` gives Ada a member row
 *   with the platform role alone. Ada signs in after the grant (ruling 50
 *   of plan 12f) and turns on TOTP.
 * - `bob`, a manager: the owner of `acme`, with TOTP.
 * - `dan`, the owner of `dan-co`, with no second factor.
 * - `cy`, a verified user with no organization.
 *
 * Each session is fresh. `keys` is empty at the end.
 */
async function platformWorld(observe?: AuthConfig["observe"]) {
  const w = seamWorld(observe ? { ...PLATFORM, observe } : PLATFORM);
  const admin = async (email: string) => {
    const made = await w.auth.api.operator.createAdmin({
      actor: SSO_APP,
      email,
      reason: "the first operators of the test",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
  };
  await admin("root@example.com");
  await w.verified("ada@example.com");
  await admin("ada@example.com");
  w.clock.advance(1_000);
  const ada = await w.signIn("ada@example.com");
  await w.enrol(ada);
  await w.verified("bob@example.com");
  const bob = await w.signIn("bob@example.com");
  const acme = await w.organization(bob, "acme");
  await w.enrol(bob);
  await w.verified("dan@example.com");
  const dan = await w.signIn("dan@example.com");
  const danCo = await w.organization(dan, "dan-co");
  await w.verified("cy@example.com");
  const cy = await w.signIn("cy@example.com");
  w.keys.length = 0;
  return { ...w, ada, bob, dan, cy, acme, danCo };
}

/** The steps of the `sso.guard_refused` events in `batches`, after a flush. It empties `batches`. */
async function guardSteps(auth: { observe: { flush(): Promise<void> } }, batches: AuthEvent[][]) {
  await auth.observe.flush();
  const steps = batches.flat().flatMap((e) => (e.name === "sso.guard_refused" ? [e.step] : []));
  batches.length = 0;
  return steps;
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
    // The seams of plan 12l. Each throws before it reads the session, so none is needed here.
    const none = null as unknown as ResolvedSession;
    await expect(countSsoLargeRead({ ...plain }, scim, "u")).rejects.toThrow(TypeError);
    await expect(canManageSomeSso({ ...plain }, none)).rejects.toThrow(TypeError);
    const write = (path: string, method = "POST") =>
      new Request(`${BASE_URL}/auth${path}?organizationId=o`, { method });
    await expect(
      checkSsoManager({ ...plain }, write("/sso/connections/create"), none, "o"),
    ).rejects.toThrow(TypeError);
    // checkSsoManager takes a POST to one of the two connection writes only.
    for (const r of [
      write("/sso/connections/delete"),
      write("/sso/connections/create", "PUT"),
      new Request(`${BASE_URL}/other/sso/connections/create`, { method: "POST" }),
    ])
      await expect(checkSsoManager(plain, r, none, "o"), r.url).rejects.toThrow(TypeError);
  });

  it("counts a manager write that the compat package counted once, for its own user only (ruling 51 Minor 1)", async () => {
    const { auth, limiter, token, user, connectionId } = await managerWorld();
    // A manager write whose body the schema refuses: core reads it and answers 400. The update
    // names a real connection in its query, so it reaches the read (plan 12l).
    const writeTo = (path: string, body: string) =>
      new Request(`${BASE_URL}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
      });
    const write = () =>
      writeTo(`/sso/connections/update?id=${encodeURIComponent(connectionId)}`, '{"more":1}');
    // Domain writes at the floor leave as many manager writes as large reads (ruling 69), so a
    // second count on either limit fails below.
    for (let i = 0; i < SSO_MANAGE_PER_USER.max - SSO_LARGE_READ_PER_USER.max; i++)
      expect((await auth.handle(writeTo("/sso/domains/update", "{}"))).status).toBe(400);
    // Half the limit: a count of the package, then core's route, which counts no more.
    const half = SSO_LARGE_READ_PER_USER.max / 2;
    for (let i = 0; i < half; i++) {
      const r = write();
      // The two counts of the shim before its read (plan 12l splits them).
      expect(await countSsoManageWrite(auth, r, user.id)).toBe(true);
      expect(await countSsoLargeRead(auth, r, user.id)).toBe(true);
      // The last write goes to core on a new request, as the shim's core call does: both marks move.
      const to = i === half - 1 ? write() : r;
      if (to !== r) moveSsoManageCount(r, to);
      expect((await auth.handle(to)).status).toBe(400);
    }
    // A mark of another user counts again, and a move of no mark adds none.
    const other = write();
    expect(await countSsoManageWrite(auth, other, "someone-else")).toBe(true);
    expect(await countSsoLargeRead(auth, other, "someone-else")).toBe(true);
    const moved = write();
    moveSsoManageCount(write(), moved);
    for (const r of [other, moved]) expect((await auth.handle(r)).status).toBe(400);
    // So far on each limit: 3 writes, 1 count of the other user, and 2 counts of the user.
    let left = 0;
    while ((await auth.handle(write())).status === 400) left++;
    expect(left).toBe(half - 2);
    expect(await countSsoManageWrite(auth, write(), user.id)).toBe(false);
    // The package counted each of its large reads with countSsoLargeRead (ruling 69, plan 12l),
    // and core counted the others once: the large-read key of the user is full.
    expect(await limiter.allow(`sso-large-read:user:${user.id}`, SSO_LARGE_READ_PER_USER)).toBe(
      false,
    );
  });

  it("takes a refusal of the package's large-read count, and gives one limit.hit (ruling 72 Low 2)", async () => {
    const batches: AuthEvent[][] = [];
    const { auth, limiter, token, user, connectionId } = await managerWorld({
      sink: { write: (b) => void batches.push([...b]) },
    });
    // The update names a real connection of the manager, so it passes the guard (plan 12l).
    const write = () =>
      new Request(
        `${BASE_URL}/auth/sso/connections/update?id=${encodeURIComponent(connectionId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: '{"more":1}',
        },
      );
    // The user spent the large reads of this hour.
    for (let i = 0; i < SSO_LARGE_READ_PER_USER.max; i++)
      expect(await limiter.allow(`sso-large-read:user:${user.id}`, SSO_LARGE_READ_PER_USER)).toBe(
        true,
      );
    // The package counts the write, then its large read, and the limit of the user refuses the read.
    const r = write();
    expect(await countSsoManageWrite(auth, r, user.id)).toBe(true);
    expect(await countSsoLargeRead(auth, r, user.id)).toBe(false);
    // The shim passes such a write to core: core answers 429 and does not count it again.
    const res = await auth.handle(r);
    expect([res.status, await res.json()]).toEqual([429, { error: "rate_limited" }]);
    await auth.observe.flush();
    // One limit.hit: the count of the package. Core did not count the write a second time.
    expect(
      batches
        .flat()
        .filter((e) => e.name === "limit.hit")
        .map((e) => e.family),
    ).toEqual(["sso-large-read:user"]);
  });

  it("takes the shim's guard mark once: the guard runs in the seam, and core runs it no more (plan 12l)", async () => {
    const batches: AuthEvent[][] = [];
    const w = await platformWorld({ sink: { write: (b) => void batches.push([...b]) } });
    const { auth } = w;
    /** A connection create of `organizationId` with the bearer `token`, as the shim gets it. */
    const create = (organizationId: string, token: string, label: string) =>
      new Request(
        `${BASE_URL}/auth/sso/connections/create?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            kind: "oidc",
            label,
            issuer: "https://login.idp.example/acme",
            clientId: "acme",
            clientSecret: "acme-secret-0123456789",
          }),
        },
      );
    /** The session of `request`, as the shim reads it. */
    const sessionOf = async (request: Request) => {
      const resolved = await auth.session(request);
      if (!resolved) throw new Error("no session");
      return resolved;
    };
    const operatorCounts = () =>
      w.keys.filter((k) => k === `operator:user:${w.ada.user.id}`).length;
    await guardSteps(auth, batches);

    // A platform operator: the seam runs the guard and its count on operator:user.
    const marked = create(w.acme, w.ada.token, "by-ada");
    expect(await checkSsoManager(auth, marked, await sessionOf(marked), w.acme)).toBeNull();
    expect(operatorCounts()).toBe(1);
    // The shim reads the body, then sends core a new request of the same text with the marks.
    const forward = new Request(marked.url, {
      method: "POST",
      headers: marked.headers,
      body: await marked.text(),
    });
    moveSsoManageCount(marked, forward);
    const made = await auth.handle(forward);
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({ connection: { organizationId: w.acme } });
    // Core took the mark: the guard ran once, so the operator counted once. The mark went at the take.
    expect(operatorCounts()).toBe(1);
    expect(takeSsoManagerChecked(forward, w.ada.user.id, w.acme)).toBeNull();
    // With no mark, core runs the guard, and the operator counts again.
    expect((await auth.handle(create(w.acme, w.ada.token, "by-ada-again"))).status).toBe(200);
    expect(operatorCounts()).toBe(2);
    expect(await guardSteps(auth, batches)).toEqual([]);

    // A mark of another organization is not taken: core runs the guard for the query's organization.
    const elsewhere = create(w.danCo, w.bob.token, "by-bob");
    expect(await checkSsoManager(auth, elsewhere, await sessionOf(elsewhere), w.acme)).toBeNull();
    const refused = await auth.handle(elsewhere);
    expect([refused.status, await refused.json()]).toEqual([403, { error: "forbidden_rank" }]);
    expect(await guardSteps(auth, batches)).toEqual(["rank"]);
    // A mark of another user is not taken either: Bob's mark on a write of Cy.
    const stranger = create(w.acme, w.cy.token, "by-cy");
    const bobs = await sessionOf(create(w.acme, w.bob.token, "unsent"));
    expect(await checkSsoManager(auth, stranger, bobs, w.acme)).toBeNull();
    const strange = await auth.handle(stranger);
    expect([strange.status, await strange.json()]).toEqual([403, { error: "forbidden_rank" }]);
    expect(await guardSteps(auth, batches)).toEqual(["rank"]);
    // Neither write made a connection of dan-co.
    const listed = await auth.api.sso?.connections.list({
      actor: SSO_APP,
      organizationId: w.danCo,
    });
    expect(listed).toEqual({ ok: true, value: [] });

    // A refusal of the seam answers core's JSON with the event of its step, and marks nothing.
    const person = create(w.acme, w.cy.token, "by-cy-again");
    const answer = await checkSsoManager(auth, person, await sessionOf(person), w.acme);
    expect([answer?.status, await answer?.json()]).toEqual([403, { error: "forbidden_rank" }]);
    expect(await guardSteps(auth, batches)).toEqual(["rank"]);
    expect(takeSsoManagerChecked(person, w.cy.user.id, w.acme)).toBeNull();
  });

  it("checks the actor of a shim mark again after the read: an owner whom another owner removes writes no row (plan 12l)", async () => {
    const batches: AuthEvent[][] = [];
    const w = await platformWorld({ sink: { write: (b) => void batches.push([...b]) } });
    const { auth } = w;
    // An organization keeps one owner or more, so Bob makes Cy a second owner of acme first.
    const added = await auth.api.addMember({
      user: w.bob.user,
      organizationId: w.acme,
      userId: w.cy.user.id,
      role: "owner",
    });
    expect(added.ok).toBe(true);
    // A small valid create of acme by Bob, as the shim gets it.
    const marked = new Request(
      `${BASE_URL}/auth/sso/connections/create?organizationId=${encodeURIComponent(w.acme)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${w.bob.token}` },
        body: JSON.stringify({
          kind: "oidc",
          label: "by-bob",
          issuer: "https://login.idp.example/acme",
          clientId: "acme",
          clientSecret: "acme-secret-0123456789",
        }),
      },
    );
    // The seam runs the guard for Bob and marks the request with the owner actor.
    expect(await checkSsoManager(auth, marked, w.bob, w.acme)).toBeNull();
    await guardSteps(auth, batches);
    // Cy removes Bob after the guard of the seam, as during the read of the shim.
    const removed = await auth.api.removeMember({
      user: w.cy.user,
      organizationId: w.acme,
      userId: w.bob.user.id,
    });
    expect(removed.ok).toBe(true);
    const res = await auth.handle(marked);
    expect([res.status, await res.json()]).toEqual([403, { error: "forbidden_rank" }]);
    // Core took the mark, so it ran no guard. The check after the read refused the actor of the mark.
    expect(takeSsoManagerChecked(marked, w.bob.user.id, w.acme)).toBeNull();
    expect(await guardSteps(auth, batches)).toEqual(["rank"]);
    const listed = await auth.api.sso?.connections.list({ actor: SSO_APP, organizationId: w.acme });
    expect(listed).toEqual({ ok: true, value: [] });
  });

  it("answers invalid_body to an id that core's query rule refuses, before any storage read (checkSsoManager, plan 12l)", async () => {
    const batches: AuthEvent[][] = [];
    const w = await platformWorld({ sink: { write: (b) => void batches.push([...b]) } });
    const { auth } = w;
    // Bob owns acme. The seam checks the id that the package gives it.
    const write = new Request(
      `${BASE_URL}/auth/sso/connections/create?organizationId=${encodeURIComponent(w.acme)}`,
      { method: "POST", headers: { authorization: `Bearer ${w.bob.token}` } },
    );
    await guardSteps(auth, batches);
    // A NUL and a lone surrogate, at which the storage port throws. Then an empty id, and an id
    // longer than the 64 characters of the id schema.
    for (const bad of ["o\u0000x", "o\ud800x", "", "x".repeat(65)]) {
      const res = await checkSsoManager(auth, write, w.bob, bad);
      expect([res?.status, await res?.json()], JSON.stringify(bad)).toEqual([
        400,
        { error: "invalid_body" },
      ]);
      // The guard did not run, and the request carries no mark.
      expect(await guardSteps(auth, batches)).toEqual([]);
      expect(takeSsoManagerChecked(write, w.bob.user.id, bad)).toBeNull();
    }
    expect(w.keys).toEqual([]);
    // The organization of Bob passes.
    expect(await checkSsoManager(auth, write, w.bob, w.acme)).toBeNull();
  });

  it("refuses a person who manages nothing before any read, with the step of the guard (canManageSomeSso, plan 12l)", async () => {
    const batches: AuthEvent[][] = [];
    const w = await platformWorld({ sink: { write: (b) => void batches.push([...b]) } });
    const { auth } = w;
    // Ada acts as Bob, a manager, through an impersonation of the product.
    const started = await auth.api.operator.impersonate({
      operator: w.ada,
      userId: w.bob.user.id,
      reason: "a support call",
      ip: null,
      userAgent: null,
    });
    if (!started.ok) throw new Error(started.code);
    const asBob = await auth.api.getSession(started.value.token);
    if (!asBob) throw new Error("no session");
    w.keys.length = 0;
    await guardSteps(auth, batches);
    /** The answer of the pre-check for `resolved`, and the steps of its events. */
    const check = async (resolved: ResolvedSession) => {
      const res = await canManageSomeSso(auth, resolved);
      return [
        res === null ? null : [res.status, await res.json()],
        await guardSteps(auth, batches),
      ];
    };
    expect(await check(w.cy)).toEqual([[403, { error: "forbidden_rank" }], ["rank"]]);
    expect(await check(w.dan)).toEqual([
      [403, { error: "second_factor_required" }],
      ["second_factor"],
    ]);
    expect(await check(w.bob)).toEqual([null, []]);
    // A platform operator who owns no organization passes, as the guard passes it for each one.
    expect(await check(w.ada)).toEqual([null, []]);
    // The impersonation step comes first: Bob's own session passes.
    expect(asBob.session.actorId).toBe(w.ada.user.id);
    expect(await check(asBob)).toEqual([[403, { error: "forbidden_rank" }], ["impersonation"]]);
    // Past the fresh window, a manager meets the last step.
    w.clock.advance(24 * HOUR_MS + 1);
    expect(await check(w.bob)).toEqual([[403, { error: "session_not_fresh" }], ["fresh"]]);
    // The pre-check counted no limit: no key of sso-manage, sso-large-read, or operator:user.
    expect(w.keys).toEqual([]);
  });

  it("refuses a member below the owner rank at the pre-check, with the step rank (canManageSomeSso, plan 12l)", async () => {
    const batches: AuthEvent[][] = [];
    const w = await platformWorld({ sink: { write: (b) => void batches.push([...b]) } });
    const { auth } = w;
    // Eve is verified, turns on TOTP, and holds the fresh session of her sign-in.
    await w.verified("eve@example.com");
    const eve = await w.signIn("eve@example.com");
    await w.enrol(eve);
    // Bob, the owner of acme, adds Eve as a plain member through the engine.
    const added = await auth.api.addMember({
      user: w.bob.user,
      organizationId: w.acme,
      userId: eve.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    await guardSteps(auth, batches);
    /** Bob gives Eve `role` in acme through the engine. */
    const give = async (role: string) => {
      const changed = await auth.api.updateMemberRole({
        user: w.bob.user,
        organizationId: w.acme,
        userId: eve.user.id,
        role,
      });
      if (!changed.ok) throw new Error(changed.code);
    };
    /** The answer of the pre-check for Eve, and the steps of its events. */
    const check = async () => {
      const res = await canManageSomeSso(auth, eve);
      return [
        res === null ? null : [res.status, await res.json()],
        await guardSteps(auth, batches),
      ];
    };
    expect(await check()).toEqual([[403, { error: "forbidden_rank" }], ["rank"]]);
    // Admin is the highest rank below owner, and it is refused too.
    await give("admin");
    expect(await check()).toEqual([[403, { error: "forbidden_rank" }], ["rank"]]);
    // The owner rank passes. So the rank is the only step that refused Eve.
    await give("owner");
    expect(await check()).toEqual([null, []]);
  });

  it("splits the counts: countSsoManageWrite counts the manager write, countSsoLargeRead the large read (plan 12l)", async () => {
    const { auth, keys, token, user, connectionId } = await managerWorld();
    const text = '{"label":"Acme SSO"}';
    const url = `${BASE_URL}/auth/sso/connections/update?id=${encodeURIComponent(connectionId)}`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    /** A write whose body sends `text`, then ends only at `close`. */
    const held = () => {
      let close = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          close = () => c.close();
        },
      });
      const request = new Request(url, {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit);
      return { request, close: () => close() };
    };
    /** The package reads `write` as `client` for longer than 8 s by the wall clock. */
    const slowRead = async (write: ReturnType<typeof held>, client?: string) => {
      const start = Date.now();
      vi.useFakeTimers({ toFake: ["Date"], now: start });
      try {
        const cap = bodyCapOf("POST /sso/connections/update");
        const read = readBodyText(write.request, cap, client ?? bodyClientOf(write.request));
        vi.setSystemTime(start + LARGE_READ_SLOW_MS + 1_000);
        write.close();
        expect(await read).toBe(text);
      } finally {
        vi.useRealTimers();
      }
    };
    // countSsoManageWrite alone counts the manager write. It binds no client and no spend.
    const alone = held();
    keys.length = 0;
    expect(await countSsoManageWrite(auth, alone.request, user.id)).toBe(true);
    expect(keys).toEqual([`sso-manage:user:${user.id}`]);
    // A request with no bind has the client ip:unknown.
    expect(bodyClientOf(alone.request)).toBe(ipBodyClient(null));
    // The read names the user as its client, so a bound spend would run at its end. None ran:
    // the limiter counted no key of sso-large-read, so the user keeps every large read.
    await slowRead(alone, `user:${user.id}`);
    expect(keys).toEqual([`sso-manage:user:${user.id}`]);
    const r = held();
    keys.length = 0;
    expect(await countSsoManageWrite(auth, r.request, user.id)).toBe(true);
    // The manager write counted. The large read did not, and the request has no client of the user.
    expect(keys).toEqual([`sso-manage:user:${user.id}`]);
    expect(bodyClientOf(r.request)).toBe(ipBodyClient(null));
    expect(await countSsoLargeRead(auth, r.request, user.id)).toBe(true);
    expect(keys).toEqual([`sso-manage:user:${user.id}`, `sso-large-read:user:${user.id}`]);
    expect(bodyClientOf(r.request)).toBe(`user:${user.id}`);
    // The package reads the body for longer than 8 s by the wall clock: the read spends.
    await slowRead(r);
    // The spend took the rest of the user's large reads: the next count is refused.
    const next = new Request(url, { method: "POST", headers, body: text });
    expect(await countSsoLargeRead(auth, next, user.id)).toBe(false);
  });
});
