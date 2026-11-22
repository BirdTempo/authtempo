import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, SsoConfig } from "../src/config.js";
import { addMember, updateMemberRole } from "../src/engine/organizations.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createConnection, updateConnection } from "../src/engine/sso/connections.js";
import { deleteDomain } from "../src/engine/sso/domains.js";
import { recheckSsoManager, requireSsoManager, type SsoActor } from "../src/engine/sso/guard.js";
import { activateSetup, previewSetup } from "../src/engine/sso/setup-activate.js";
import {
  addSetupDomain,
  createPendingScimToken,
  saveDraftConnection,
  verifySetupDomain,
} from "../src/engine/sso/setup-drafts.js";
import { createSetupLink, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { setupSessionRoute } from "../src/http/routes/sso-setup.js";
import { newId } from "../src/primitives/ids.js";
import { ok } from "../src/result.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { recordAddress, recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { SSO_APP, ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

const HOUR_MS = 3_600_000;
const META = { ip: recordAddress("198.51.100.9"), userAgent: "setup-activate-test" };
const SECRET = "idp-client-secret-0123456789";
const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: "https://login.idp.example/acme",
  clientId: "acme-client",
  clientSecret: SECRET,
} as const;
const NOT_TESTED = { ok: false, code: "setup_not_tested", status: 409 };
const INVALID = { ok: false, code: "setup_link_invalid", status: 404 };
const RANK = { ok: false, code: "forbidden_rank", status: 403 };
const STEPS = ["domain", "connection", "directory"] as ("domain" | "connection" | "directory")[];

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** SSO with setup on, an owner of acme who passes the manager guard, and SCIM. */
async function world(extra: Partial<AuthConfig> = {}) {
  const w = ssoAuth({
    sso: { oidc: true, saml: true, setup: {} } as SsoConfig,
    scim: {},
    password: { hash: FAST, uniformSignUp: false },
    ...extra,
  });
  const owner = await managerSession(w, "owner@acme.example", "acme");
  const actor = await guarded(w, owner.token, owner.org);
  return { w, owner, actor, org: owner.org };
}
type X = Awaited<ReturnType<typeof world>>;

/** The actor of the manager guard for a session token, as a route gets it. */
async function guarded(w: X["w"], token: string, org: string): Promise<SsoActor> {
  const resolved = await resolveSession(w.config, token);
  if (!resolved) throw new Error("the session ended");
  const r = await requireSsoManager(w.config, resolved, org);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** A link with a setup session, an OIDC draft, a verified and a pending domain, and a pending token. */
async function ready(x: X, kind: "oidc" | "saml" = "oidc", tag = "setup") {
  const { w, actor, org } = x;
  const made = await createSetupLink(w.config, actor, {
    organizationId: org,
    steps: STEPS,
    kinds: ["oidc", "saml"],
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
  const s = checked.value;
  let cert: string | null = null;
  const saved =
    kind === "oidc"
      ? await saveDraftConnection(w.config, s, OIDC)
      : await (async () => {
          const idp = await createTestIdp({ alg: "rsa" });
          cert = idp.certificatePem;
          return saveDraftConnection(w.config, s, {
            kind: "saml",
            label: "Acme SAML",
            idpEntityId: idp.entityId,
            ssoUrl: "https://sso.idp.example/saml/acme",
            certificates: [idp.certificatePem],
          });
        })();
  if (!saved.ok) throw new Error(saved.code);
  const added = await addSetupDomain(w.config, s, `${tag}.example`);
  if (!added.ok) throw new Error(added.code);
  const record = added.value.record;
  if (record === null) throw new Error("no record");
  w.answers.a[record.name] = [record.value];
  w.answers.b[record.name] = [record.value];
  const verified = await verifySetupDomain(w.config, s, added.value.id);
  if (!verified.ok) throw new Error(verified.code);
  const pending = await addSetupDomain(w.config, s, `${tag}-pending.example`);
  if (!pending.ok) throw new Error(pending.code);
  const token = await createPendingScimToken(w.config, s);
  if (!token.ok) throw new Error(token.code);
  recordCredential(token.value.token);
  // The domain, claim, and token writes of the setup moved the version of the draft (ruling R32).
  const draft = await w.storage.findOne("ssoConnection", [
    { field: "id", op: "eq", value: saved.value.id },
  ]);
  return {
    /** The version of the draft when the setup is done: what the owner reads in the preview. */
    v: draft?.version ?? 0,
    s,
    linkId: s.link.id,
    connId: saved.value.id,
    domainId: added.value.id,
    pendingDomainId: pending.value.id,
    pendingRecord: pending.value.record,
    tokenId: token.value.id,
    cert,
    clearToken: token.value.token,
  };
}
type R = Awaited<ReturnType<typeof ready>>;

/** A passed run of the draft at `version`, as the callback of a test run writes it. */
async function pass(x: X, r: R, version = r.v) {
  const now = x.w.clock.now();
  return x.w.storage.create("ssoTestRun", {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    organizationId: x.org,
    connectionId: r.connId,
    linkId: r.linkId,
    outcome: "passed",
    step: null,
    attributeNames: ["email"],
    domainClaimed: true,
    draftVersion: version,
  });
}

const noop = async () => ok(undefined);

/**
 * The activation of an owner who read the draft just before: it sends the version that the draft
 * has now, as the preview showed it. A link with no draft sends 1. The tests of R28 call
 * `activateSetup` with a named version instead.
 */
async function activateRead(
  config: Parameters<typeof activateSetup>[0],
  actor: SsoActor,
  linkId: string,
  recheck: Parameters<typeof activateSetup>[4],
) {
  const draft = await config.storage.findOne("ssoConnection", [
    { field: "setupLinkId", op: "eq", value: linkId },
  ]);
  return activateSetup(config, actor, linkId, draft?.version ?? 1, recheck);
}

/** Every row that an activation can change, for a before and after compare. */
async function tables(w: X["w"]) {
  const find = (
    m:
      | "ssoConnection"
      | "ssoDomain"
      | "scimToken"
      | "ssoSetupLink"
      | "ssoSetupSession"
      | "operatorAudit",
  ) => w.storage.findMany(m, [], { sort: { field: "id", dir: "asc" } });
  return {
    connections: await find("ssoConnection"),
    domains: await find("ssoDomain"),
    tokens: await find("scimToken"),
    links: await find("ssoSetupLink"),
    sessions: await find("ssoSetupSession"),
    audit: await find("operatorAudit"),
  };
}

const auditOf = (w: X["w"], action: string) =>
  w.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }]);

describe("the condition of the activation", () => {
  it("answers 409 setup_not_tested for a draft with no passed run, and changes nothing", async () => {
    const x = await world();
    const r = await ready(x);
    x.w.clock.advance(1000);
    const before = await tables(x.w);
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(NOT_TESTED);
    expect(await tables(x.w)).toEqual(before);
  });

  it("answers 409 setup_not_tested for a failed or a pending run", async () => {
    const x = await world();
    const r = await ready(x);
    const run = await pass(x, r);
    await x.w.storage.update("ssoTestRun", [{ field: "id", op: "eq", value: run.id }], {
      outcome: "failed",
    });
    await x.w.storage.create("ssoTestRun", {
      ...run,
      id: newId(x.w.clock.now()),
      outcome: "pending",
    });
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(NOT_TESTED);
  });

  it("answers 409 setup_not_tested when the draft changed after the pass (pass at v1, draft at v2)", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.clock.advance(1000);
    const changed = await saveDraftConnection(x.w.config, r.s, { ...OIDC, label: "Acme Okta 2" });
    expect(changed.ok).toBe(true);
    expect(
      (await x.w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: r.connId }]))
        ?.version,
    ).toBe(r.v + 1);
    const before = await tables(x.w);
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(NOT_TESTED);
    expect(await tables(x.w)).toEqual(before);
  });

  it("answers 409 setup_not_tested when the owner changes the draft after the pass", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.clock.advance(1000);
    const changed = await updateConnection(x.w.config, x.actor, {
      id: r.connId,
      label: "Owner label",
    });
    expect(changed.ok).toBe(true);
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(NOT_TESTED);
  });

  it("answers 409 setup_not_tested when the link has no draft", async () => {
    const x = await world();
    const made = await createSetupLink(x.w.config, x.actor, {
      organizationId: x.org,
      steps: STEPS,
      kinds: ["oidc"],
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    expect(await activateRead(x.w.config, x.actor, made.value.id, noop)).toEqual(NOT_TESTED);
  });

  it("answers setup_not_tested when a write of the owner lands between the read and the update of the draft", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.clock.advance(1000);
    // The owner path takes no lock of the link. Its commit can fall between our read of the
    // passed run and our write of the draft. The hook puts that write in the same transaction.
    const storage = inTransaction(x.w.config.storage, async (tx, model, op) => {
      if (model !== "ssoTestRun" || op !== "findMany") return;
      await tx.update("ssoConnection", [{ field: "id", op: "eq", value: r.connId }], {
        version: r.v + 1,
        label: "Racing owner",
      });
    });
    const before = await tables(x.w);
    expect(await activateRead({ ...x.w.config, storage }, x.actor, r.linkId, noop)).toEqual(
      NOT_TESTED,
    );
    const after = await tables(x.w);
    // The refusal undoes the write of the hook with the rest of the transaction.
    expect(after.connections[0]).toMatchObject({ draft: true, enabled: false, version: r.v });
    expect({ ...after, connections: [] }).toEqual({ ...before, connections: [] });
  });
});

/**
 * A storage whose transactions give `hook` the chance to act after each call of the
 * transaction. The hook gets the transaction itself, so what it writes is part of the same
 * transaction, as a write that another connection committed in between.
 */
function inTransaction(
  storage: StorageAdapter,
  hook: (tx: StorageAdapter, model: string, op: string) => Promise<void>,
  replace: Partial<Record<string, (...a: never[]) => unknown>> = {},
): StorageAdapter {
  const wrapTx = (tx: StorageAdapter): StorageAdapter =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: never[]) => {
          const swap = replace[String(prop)];
          const out = swap
            ? await swap.apply(target, args)
            : await (value as (...a: never[]) => unknown).apply(target, args);
          await hook(tx, String(args[0]), String(prop));
          return out;
        };
      },
    });
  return new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "transaction")
        return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
          target.transaction((tx) => fn(wrapTx(tx)));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the act", () => {
  it("makes the draft live in one transaction", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.clock.advance(5000);
    const at = x.w.clock.now();
    const before = await tables(x.w);
    const done = await activateRead(x.w.config, x.actor, r.linkId, noop);
    if (!done.ok) throw new Error(done.code);
    expect(done.value).toMatchObject({ id: r.connId, enabled: true, draft: false });
    const row = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: r.connId },
    ]);
    expect(row).toMatchObject({ enabled: true, draft: false, version: r.v, updatedAt: at });
    expect(row?.updatedAt.getTime()).toBeGreaterThan(
      before.connections[0]?.updatedAt.getTime() ?? 0,
    );
    const domains = await x.w.storage.findMany("ssoDomain", []);
    const verified = domains.find((d) => d.id === r.domainId);
    const pending = domains.find((d) => d.id === r.pendingDomainId);
    expect(verified).toMatchObject({ connectionId: r.connId, enforce: false, updatedAt: at });
    expect(pending).toMatchObject({ connectionId: null, enforce: false });
    const token = await x.w.storage.findOne("scimToken", [
      { field: "id", op: "eq", value: r.tokenId },
    ]);
    expect(token).toMatchObject({ pending: false, updatedAt: at });
    const link = await x.w.storage.findOne("ssoSetupLink", [
      { field: "id", op: "eq", value: r.linkId },
    ]);
    expect(link).toMatchObject({ endedAt: at, updatedAt: at, revokedAt: null });
    const sessions = await x.w.storage.findMany("ssoSetupSession", [
      { field: "linkId", op: "eq", value: r.linkId },
    ]);
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.endedAt).toEqual(at);
    const rows = await auditOf(x.w, "sso_setup_link_activate");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      organizationId: x.org,
      linkId: r.linkId,
      connectionId: r.connId,
      domainIds: [r.domainId],
      tokenId: r.tokenId,
    });
    expect(await auditOf(x.w, "sso_connection_update")).toHaveLength(1);
    // No value of the link, the token, or the secret reaches an audit row.
    const text = JSON.stringify(await x.w.storage.findMany("operatorAudit", []));
    expect(text).not.toContain(r.clearToken);
    expect(text).not.toContain(SECRET);
  });

  it("lets a new link be minted and writes nothing for a revoke of the ended link", async () => {
    const x = await world();
    const a = await ready(x);
    const b = await createSetupLink(x.w.config, x.actor, {
      organizationId: x.org,
      steps: STEPS,
      kinds: ["oidc"],
      note: "Second",
    });
    expect(b.ok).toBe(true);
    // Two live links: a third mint is refused until the activation ends one.
    const third = { organizationId: x.org, steps: STEPS, kinds: ["oidc" as const], note: "Third" };
    expect(await createSetupLink(x.w.config, x.actor, third)).toMatchObject({
      ok: false,
      code: "setup_link_limit",
    });
    await pass(x, a);
    expect((await activateRead(x.w.config, x.actor, a.linkId, noop)).ok).toBe(true);
    expect((await createSetupLink(x.w.config, x.actor, third)).ok).toBe(true);
    const before = await tables(x.w);
    expect(await revokeSetupLink(x.w.config, x.actor, a.linkId)).toEqual(ok(undefined));
    expect(await tables(x.w)).toEqual(before);
  });

  it("rolls back every write when the audit write fails, and sends no notice", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.clock.advance(1000);
    const before = await tables(x.w);
    const sent = x.w.mail.length;
    const storage = inTransaction(x.w.config.storage, async () => {}, {
      create: ((model: string) => {
        if (model === "operatorAudit") throw new Error("the audit write failed");
        return undefined;
      }) as never,
    });
    await expect(activateRead({ ...x.w.config, storage }, x.actor, r.linkId, noop)).rejects.toThrow(
      "the audit write failed",
    );
    expect(await tables(x.w)).toEqual(before);
    expect(x.w.mail).toHaveLength(sent);
  });

  it("never sets enforce, also for a verified domain of the link", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    await activateRead(x.w.config, x.actor, r.linkId, noop);
    for (const d of await x.w.storage.findMany("ssoDomain", [])) expect(d.enforce).toBe(false);
  });

  it("routes only the verified domain of two", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    await activateRead(x.w.config, x.actor, r.linkId, noop);
    const routed = (await x.w.storage.findMany("ssoDomain", []))
      .filter((d) => d.connectionId !== null)
      .map((d) => d.id);
    expect(routed).toEqual([r.domainId]);
  });

  it("refuses a draft whose only passed run belongs to another connection at the same version", async () => {
    const x = await world();
    const r = await ready(x);
    // A passed run of another connection of the organization, at version 1 like the draft.
    const other = await createConnection(x.w.config, x.actor, {
      ...OIDC,
      organizationId: x.org,
      label: "Other IdP",
    });
    if (!other.ok) throw new Error(other.code);
    await pass(x, { ...r, connId: other.value.id }, 1);
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(NOT_TESTED);
    const draft = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: r.connId },
    ]);
    expect(draft).toMatchObject({ draft: true, enabled: false });
  });

  it("lists in the audit only the domains that this activation routed (a claim lost in between)", async () => {
    const x = await world();
    const r = await ready(x);
    const second = await addSetupDomain(x.w.config, r.s, "second.example");
    if (!second.ok || second.value.record === null) throw new Error("no second domain");
    x.w.answers.a[second.value.record.name] = [second.value.record.value];
    x.w.answers.b[second.value.record.name] = [second.value.record.value];
    expect((await verifySetupDomain(x.w.config, r.s, second.value.id)).ok).toBe(true);
    // The writes above moved the version (ruling R32), so the test run comes after them.
    await pass(x, r, r.v + 2);
    // The claim of the second domain is lost right after the first read of the domains of the
    // transaction. The hook runs in the same transaction, as a commit of another connection.
    // Whatever the order of the act, the audit must list the routed domains and no others.
    let lost = false;
    const storage = inTransaction(x.w.config.storage, async (tx, model, op) => {
      if (model !== "ssoDomain" || op !== "findMany" || lost) return;
      lost = true;
      await tx.update("ssoDomain", [{ field: "id", op: "eq", value: second.value.id }], {
        claimedDomain: null,
      });
    });
    const done = await activateRead({ ...x.w.config, storage }, x.actor, r.linkId, noop);
    expect(done.ok).toBe(true);
    const routed = (await x.w.storage.findMany("ssoDomain", []))
      .filter((d) => d.connectionId !== null)
      .map((d) => d.id)
      .sort();
    const rows = await auditOf(x.w, "sso_setup_link_activate");
    const row = rows[0];
    if (!row) throw new Error("no audit row");
    const listed = [...(row.data as { domainIds: string[] }).domainIds].sort();
    // This proves the order only: the audit list equals the routed set when the claim is lost
    // after the first domain read. The filter on `connectionId` has its own test below.
    expect(listed).toEqual(routed);
    expect(lost).toBe(true);
  });

  it("does not take over a domain that a live connection already holds, and keeps its enforce", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const live = await createConnection(x.w.config, x.actor, {
      ...OIDC,
      organizationId: x.org,
      label: "Live IdP",
    });
    if (!live.ok) throw new Error(live.code);
    // The owner path routes the verified domain of the link to the live connection, with enforce.
    await x.w.storage.update("ssoDomain", [{ field: "id", op: "eq", value: r.domainId }], {
      connectionId: live.value.id,
      enforce: true,
    });
    const done = await activateRead(x.w.config, x.actor, r.linkId, noop);
    expect(done.ok).toBe(true);
    const domain = await x.w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: r.domainId },
    ]);
    expect(domain).toMatchObject({ connectionId: live.value.id, enforce: true });
    const rows = await auditOf(x.w, "sso_setup_link_activate");
    expect(rows[0]?.data).toMatchObject({ domainIds: [] });
  });

  it("does not route a domain of the organization that the link did not add", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    await activateRead(x.w.config, x.actor, r.linkId, noop);
    // acme.example is the verified domain that the world makes; the manager added it.
    const own = (await x.w.storage.findMany("ssoDomain", [])).find(
      (d) => d.domain === "acme.example",
    );
    expect(own?.connectionId ?? null).toBeNull();
  });

  it("emits sso.activated once, with ids only, after the commit; a refusal emits none", async () => {
    const batches: { name: string }[][] = [];
    const x = await world({ observe: { sink: { write: (b) => void batches.push([...b]) } } });
    const seen = async () => {
      await x.w.config.observe.flush();
      return batches.flat().filter((e) => e.name === "sso.activated");
    };
    const r = await ready(x);
    // No passed run yet: the act refuses and the event stays silent.
    const refused = await activateRead(x.w.config, x.actor, r.linkId, noop);
    expect(refused.ok).toBe(false);
    expect(await seen()).toEqual([]);
    await pass(x, r);
    const done = await activateRead(x.w.config, x.actor, r.linkId, noop);
    expect(done.ok).toBe(true);
    // The sink adds an envelope (time, level). The field list is pinned by the EVENTS table.
    expect(await seen()).toMatchObject([
      {
        name: "sso.activated",
        organizationId: x.org,
        connectionId: r.connId,
        linkId: r.linkId,
      },
    ]);
  });

  it("sends sso_activated to each owner after the commit, and runs the audit hook after it", async () => {
    const seen: { action: string; ended: boolean }[] = [];
    let linkId = "";
    const x = await world({
      hooks: {
        operator: {
          afterAction: async (e) => {
            const link = linkId
              ? await x.w.storage.findOne("ssoSetupLink", [
                  { field: "id", op: "eq", value: linkId },
                ])
              : null;
            seen.push({ action: e.audit.action, ended: link?.endedAt != null });
          },
        },
      },
    });
    const second = await verifiedSession(x.w, "second@acme.example");
    const added = await addMember(x.w.config, {
      user: x.owner.user,
      organizationId: x.org,
      userId: second.user.id,
      role: "owner",
    });
    expect(added.ok).toBe(true);
    const guest = await verifiedSession(x.w, "guest@acme.example");
    await addMember(x.w.config, {
      user: x.owner.user,
      organizationId: x.org,
      userId: guest.user.id,
      role: "member",
    });
    const r = await ready(x);
    linkId = r.linkId;
    await pass(x, r);
    x.w.mail.length = 0;
    seen.length = 0;
    expect((await activateRead(x.w.config, x.actor, r.linkId, noop)).ok).toBe(true);
    const notices = x.w.mail.filter((m) => m.subject.startsWith("SSO setup notice"));
    expect(notices.map((m) => m.to).sort()).toEqual(["owner@acme.example", "second@acme.example"]);
    for (const m of notices) expect(m.text).toContain("turned on");
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.action).sort()).toEqual([
      "sso_connection_update",
      "sso_setup_link_activate",
    ]);
    for (const s of seen) expect(s.ended).toBe(true);
  });

  it("answers ok when a mail port throws, and the act stays", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.config.mail.send = async () => {
      throw new Error("mail is down");
    };
    expect((await activateRead(x.w.config, x.actor, r.linkId, noop)).ok).toBe(true);
    expect(
      (await x.w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: r.connId }]))
        ?.enabled,
    ).toBe(true);
  });
});

describe("who may activate", () => {
  it("stops at the re-check of the route after the body read, and changes nothing", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const before = await tables(x.w);
    let calls = 0;
    const gone = await activateRead(x.w.config, x.actor, r.linkId, async () => {
      calls += 1;
      return { ok: false, code: "unauthorized", status: 401 };
    });
    expect(gone).toEqual({ ok: false, code: "unauthorized", status: 401 });
    expect(calls).toBe(1);
    expect(await tables(x.w)).toEqual(before);
    expect((await activateRead(x.w.config, x.actor, r.linkId, async () => ok(undefined))).ok).toBe(
      true,
    );
  });

  it("answers forbidden_rank to an owner who lost the rank after the guard", async () => {
    const x = await world();
    const second = await verifiedSession(x.w, "second@acme.example");
    await addMember(x.w.config, {
      user: x.owner.user,
      organizationId: x.org,
      userId: second.user.id,
      role: "owner",
    });
    const r = await ready(x);
    await pass(x, r);
    const demoted = await updateMemberRole(x.w.config, {
      user: second.user,
      organizationId: x.org,
      userId: x.owner.user.id,
      role: "member",
    });
    expect(demoted.ok).toBe(true);
    const before = await tables(x.w);
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(RANK);
    expect(await tables(x.w)).toEqual(before);
  });

  it("answers forbidden_rank to a member below owner at the guard, and writes nothing", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const member = await verifiedSession(x.w, "member@acme.example");
    await addMember(x.w.config, {
      user: x.owner.user,
      organizationId: x.org,
      userId: member.user.id,
      role: "admin",
    });
    const resolved = await resolveSession(x.w.config, member.token);
    if (!resolved) throw new Error("no session");
    const guard = await requireSsoManager(x.w.config, resolved, x.org);
    expect(guard).toMatchObject({ ok: false, code: "forbidden_rank", status: 403 });
    expect(await auditOf(x.w, "sso_setup_link_activate")).toEqual([]);
  });

  it("gives the refusal of the guard to an owner with no fresh proof", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    x.w.clock.advance(x.w.config.session.freshMinutes * 60_000);
    // A route runs the guard first, so the act is never reached.
    const resolved = await resolveSession(x.w.config, x.owner.token);
    if (!resolved) throw new Error("no session");
    expect(await requireSsoManager(x.w.config, resolved, x.org)).toMatchObject({
      ok: false,
      code: "session_not_fresh",
    });
    expect(await auditOf(x.w, "sso_setup_link_activate")).toEqual([]);
  });

  it("answers unauthorized when the session of the owner ended after the guard", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const resolved = await resolveSession(x.w.config, x.owner.token);
    if (!resolved) throw new Error("no session");
    await x.w.storage.delete("session", [{ field: "id", op: "eq", value: resolved.session.id }]);
    const before = await tables(x.w);
    expect(
      await activateRead(x.w.config, x.actor, r.linkId, async () =>
        recheckSsoManager(x.w.config, x.actor, x.org).then((c) => (c.ok ? ok(undefined) : c)),
      ),
    ).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(await tables(x.w)).toEqual(before);
  });

  it("answers forbidden_rank to an owner of another organization, and writes nothing", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const other = await managerSession(x.w, "owner@bexley.example", "bexley");
    const foreign = await guarded(x.w, other.token, other.org);
    const before = await tables(x.w);
    expect(await activateRead(x.w.config, foreign, r.linkId, noop)).toEqual(RANK);
    expect(await previewSetup(x.w.config, foreign, r.linkId)).toEqual(RANK);
    expect(await tables(x.w)).toEqual(before);
  });

  it("lets the app actor activate", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    expect((await activateRead(x.w.config, SSO_APP, r.linkId, noop)).ok).toBe(true);
    const rows = await auditOf(x.w, "sso_setup_link_activate");
    expect(rows[0]).toMatchObject({ actorKind: "app", actorId: "sso-test" });
  });

  it("gives the holder of a link no route to activate", () => {
    expect(() =>
      setupSessionRoute("POST /sso/setup-links/activate" as never, async () => new Response()),
    ).toThrow();
  });
});

describe("a link that is not live", () => {
  it("answers 404 setup_link_invalid for an ended link: the second activation", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    expect((await activateRead(x.w.config, x.actor, r.linkId, noop)).ok).toBe(true);
    const before = await tables(x.w);
    expect(await activateRead(x.w.config, x.actor, r.linkId, noop)).toEqual(INVALID);
    expect(await tables(x.w)).toEqual(before);
  });

  it("answers 404 setup_link_invalid for a revoked link, and for an expired link", async () => {
    const x = await world();
    const a = await ready(x);
    await pass(x, a);
    expect((await revokeSetupLink(x.w.config, x.actor, a.linkId)).ok).toBe(true);
    expect(await activateRead(x.w.config, x.actor, a.linkId, noop)).toEqual(INVALID);
    const b = await ready(x, "oidc", "second");
    await pass(x, b);
    x.w.clock.advance(73 * HOUR_MS);
    const before = await tables(x.w);
    expect(await activateRead(x.w.config, x.actor, b.linkId, noop)).toEqual(INVALID);
    expect(await tables(x.w)).toEqual(before);
    expect(
      (await x.w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: b.connId }]))
        ?.draft,
    ).toBe(true);
  });

  it("answers 404 not_found for an id with no link", async () => {
    const x = await world();
    expect(await activateRead(x.w.config, x.actor, "no-such-link", noop)).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("answers 404 not_found while sso.setup is off", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const off = { ...x.w.config, sso: { ...x.w.config.sso, setup: null } } as never;
    expect(await activateRead(off, x.actor, r.linkId, noop)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await previewSetup(off, x.actor, r.linkId)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("the race of two activations", () => {
  it("lets one of two parallel activations win, with one set of audit rows", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const results = await Promise.all([
      activateRead(x.w.config, x.actor, r.linkId, noop),
      activateRead(x.w.config, x.actor, r.linkId, noop),
    ]);
    expect(results.filter((v) => v.ok)).toHaveLength(1);
    const lost = results.find((v) => !v.ok);
    expect(lost).toMatchObject({ ok: false });
    expect([404, 409]).toContain(lost && !lost.ok ? lost.status : 0);
    expect(await auditOf(x.w, "sso_setup_link_activate")).toHaveLength(1);
    expect(await auditOf(x.w, "sso_connection_update")).toHaveLength(1);
  });

  it("answers 404 for the loser that read the link before the winner committed", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    let armed = true;
    // The first read of the link row is the read of the loser. The winner commits right after it.
    const storage = new Proxy(x.w.config.storage, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "findOne") return typeof value === "function" ? value.bind(target) : value;
        return async (model: string, where: never, ...rest: never[]) => {
          const row = await (value as (...a: unknown[]) => Promise<unknown>).call(
            target,
            model,
            where,
            ...rest,
          );
          if (model === "ssoSetupLink" && armed) {
            armed = false;
            const won = await activateRead(x.w.config, x.actor, r.linkId, noop);
            expect(won.ok).toBe(true);
          }
          return row;
        };
      },
    });
    const lost = await activateRead({ ...x.w.config, storage }, x.actor, r.linkId, noop);
    expect(lost).toEqual(INVALID);
    expect(await auditOf(x.w, "sso_setup_link_activate")).toHaveLength(1);
    expect(await auditOf(x.w, "sso_connection_update")).toHaveLength(1);
  });
});

const CONFLICT = { ok: false, code: "conflict", status: 409 };

describe("the draft that the owner read (R28)", () => {
  /** The owner reads the preview, then the link holder edits the draft and runs a new test that passes. */
  async function swapAfterPreview() {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const preview = await previewSetup(x.w.config, x.actor, r.linkId);
    if (!preview.ok || preview.value === null) throw new Error("no preview");
    x.w.clock.advance(1000);
    const swapped =await saveDraftConnection(x.w.config, r.s, {
      ...OIDC,
      issuer: "https://login.thief.example/acme",
    });
    expect(swapped.ok).toBe(true);
    await pass(x, r, r.v + 1);
    return { x, r, seen: preview.value.version };
  }

  it("shows the version of the draft in the preview", async () => {
    const x = await world();
    const r = await ready(x);
    const p = await previewSetup(x.w.config, x.actor, r.linkId);
    expect(p.ok && p.value?.version).toBe(r.v);
    await saveDraftConnection(x.w.config, r.s, { ...OIDC, label: "Acme Okta 2" });
    const next = await previewSetup(x.w.config, x.actor, r.linkId);
    expect(next.ok && next.value?.version).toBe(r.v + 1);
  });

  it("answers 409 conflict for a draft that was changed and tested again after the preview, and keeps the connection inactive", async () => {
    const { x, r, seen } = await swapAfterPreview();
    expect(seen).toBe(r.v);
    const before = await tables(x.w);
    expect(await activateSetup(x.w.config, x.actor, r.linkId, seen, noop)).toEqual(CONFLICT);
    expect(await tables(x.w)).toEqual(before);
    const row = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: r.connId },
    ]);
    expect(row).toMatchObject({ draft: true, enabled: false, version: r.v + 1 });
    expect(await auditOf(x.w, "sso_setup_link_activate")).toEqual([]);
  });

  it("activates the changed draft when the owner reads the new version", async () => {
    const { x, r } = await swapAfterPreview();
    const again = await previewSetup(x.w.config, x.actor, r.linkId);
    if (!again.ok || again.value === null) throw new Error("no preview");
    expect(again.value.version).toBe(r.v + 1);
    expect((await activateSetup(x.w.config, x.actor, r.linkId, r.v + 1, noop)).ok).toBe(true);
  });

  it("answers 409 conflict for a version that the draft never had", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    expect(await activateSetup(x.w.config, x.actor, r.linkId, r.v + 7, noop)).toEqual(CONFLICT);
  });

  it("compares the version inside the transaction, after the lock: a write that lands after the read is a conflict", async () => {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    await pass(x, r, r.v + 1);
    // The holder's edit commits after the link lock and before the draft read of the act: the
    // hook runs it in the same transaction. The act must compare the version after it.
    const storage = inTransaction(x.w.config.storage, async (tx, model, op) => {
      if (model !== "ssoSetupLink" || op !== "update") return;
      await tx.update("ssoConnection", [{ field: "id", op: "eq", value: r.connId }], {
        version: r.v + 1,
      });
    });
    expect(await activateSetup({ ...x.w.config, storage }, x.actor, r.linkId, r.v, noop)).toEqual(
      CONFLICT,
    );
  });
});

describe("what the owner read besides the draft (R32)", () => {
  /** The version of the draft of the link now. */
  const versionOf = async (x: X, r: R) =>
    (await x.w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: r.connId }]))
      ?.version;

  /**
   * The owner reads the preview of a tested link, then `write` changes what the preview shows.
   * The version must move by 1, and the activation with the old version must be a conflict.
   */
  async function afterPreview(write: (x: X, r: R) => Promise<unknown>) {
    const x = await world();
    const r = await ready(x);
    await pass(x, r);
    const preview = await previewSetup(x.w.config, x.actor, r.linkId);
    if (!preview.ok || preview.value === null) throw new Error("no preview");
    const seen = preview.value.version;
    x.w.clock.advance(1000);
    await write(x, r);
    return { x, r, seen };
  }

  async function expectBump(write: (x: X, r: R) => Promise<unknown>) {
    const { x, r, seen } = await afterPreview(write);
    expect(await versionOf(x, r)).toBe(seen + 1);
    expect(await activateSetup(x.w.config, x.actor, r.linkId, seen, noop)).toEqual(CONFLICT);
    const row = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: r.connId },
    ]);
    expect(row).toMatchObject({ draft: true, enabled: false });
  }

  const addAndVerifyEvil = async (x: X, r: R) => {
    const added = await addSetupDomain(x.w.config, r.s, "evil.example");
    if (!added.ok || added.value.record === null) throw new Error("no domain");
    x.w.answers.a[added.value.record.name] = [added.value.record.value];
    x.w.answers.b[added.value.record.name] = [added.value.record.value];
    const verified = await verifySetupDomain(x.w.config, r.s, added.value.id);
    expect(verified.ok).toBe(true);
  };

  it("answers 409 conflict when the link holder adds and verifies a domain after the preview, and routes nothing to it", async () => {
    const { x, r, seen } = await afterPreview(addAndVerifyEvil);
    // The test passed for the draft as it was. The owner read setup.example only.
    expect(await activateSetup(x.w.config, x.actor, r.linkId, seen, noop)).toEqual(CONFLICT);
    const domains = await x.w.storage.findMany("ssoDomain", []);
    expect(domains.filter((d) => d.connectionId !== null)).toEqual([]);
    expect(domains.map((d) => d.domain)).toContain("evil.example");
  });

  it("bumps the version when a domain is added", async () => {
    await expectBump(async (x, r) => {
      expect((await addSetupDomain(x.w.config, r.s, "other.example")).ok).toBe(true);
    });
  });

  it("bumps the version when a pending domain gets a new challenge", async () => {
    await expectBump(async (x, r) => {
      expect((await addSetupDomain(x.w.config, r.s, "setup-pending.example")).ok).toBe(true);
    });
  });

  it("bumps the version when a domain is verified", async () => {
    await expectBump(async (x, r) => {
      const record = r.pendingRecord;
      if (record === null) throw new Error("no record");
      x.w.answers.a[record.name] = [record.value];
      x.w.answers.b[record.name] = [record.value];
      expect((await verifySetupDomain(x.w.config, r.s, r.pendingDomainId)).ok).toBe(true);
    });
  });

  it("bumps the version when the owner removes a domain of the link", async () => {
    await expectBump(async (x, r) => {
      expect((await deleteDomain(x.w.config, x.actor, { id: r.pendingDomainId })).ok).toBe(true);
    });
  });

  it("bumps the version when the pending SCIM token is replaced", async () => {
    await expectBump(async (x, r) => {
      expect((await createPendingScimToken(x.w.config, r.s)).ok).toBe(true);
    });
  });

  it("does not bump the draft of another link", async () => {
    const x = await world();
    const r = await ready(x, "oidc", "one");
    const r2 = await ready(x, "oidc", "two");
    const before = await versionOf(x, r);
    expect((await addSetupDomain(x.w.config, r2.s, "third.example")).ok).toBe(true);
    expect(await versionOf(x, r)).toBe(before);
  });
});

describe("the preview", () => {
  it("shows the OIDC issuer, the sign-in host, the verified domain, and the token name", async () => {
    const x = await world();
    const r = await ready(x);
    const p = await previewSetup(x.w.config, x.actor, r.linkId);
    expect(p).toEqual(
      ok({
        kind: "oidc",
        version: r.v,
        issuerOrEntityId: OIDC.issuer,
        signInHost: "login.idp.example",
        fingerprints: [],
        domains: ["setup.example"],

        scim: {
          name: "Setup link directory",
          scopes: ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"],
        },
      }),
    );
  });

  it("shows the SAML entity id, the host of the sign-in URL, and the SHA-256 fingerprint of each certificate", async () => {
    const x = await world();
    const r = await ready(x, "saml");
    const p = await previewSetup(x.w.config, x.actor, r.linkId);
    if (!p.ok || p.value === null) throw new Error("no preview");
    expect(p.value.kind).toBe("saml");
    expect(p.value.signInHost).toBe("sso.idp.example");
    // An independent route to the value: the base64 body, decoded with atob, then WebCrypto.
    const body = (r.cert ?? "").replace(/-----[A-Z ]+-----|\s/g, "");
    const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
    const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
    const expected = Array.from(sum, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(p.value.fingerprints).toEqual([expected]);
    expect(p.value.issuerOrEntityId).toMatch(/^https?:\/\//);
  });

  it("holds no secret and no token", async () => {
    const x = await world();
    const r = await ready(x);
    const text = JSON.stringify(await previewSetup(x.w.config, x.actor, r.linkId));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(r.clearToken);
    expect(text).not.toContain("clientSecret");
  });

  it("answers null for a link with no draft, and 404 for an unknown link", async () => {
    const x = await world();
    const made = await createSetupLink(x.w.config, x.actor, {
      organizationId: x.org,
      steps: STEPS,
      kinds: ["oidc"],
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    expect(await previewSetup(x.w.config, x.actor, made.value.id)).toEqual(ok(null));
    expect(await previewSetup(x.w.config, x.actor, "no-such-link")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("changes nothing", async () => {
    const x = await world();
    const r = await ready(x);
    const before = await tables(x.w);
    await previewSetup(x.w.config, x.actor, r.linkId);
    expect(await tables(x.w)).toEqual(before);
  });
});
