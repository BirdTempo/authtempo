import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { addMember, deleteOrganization, updateMemberRole } from "../src/engine/organizations.js";
import { resolveSession } from "../src/engine/sessions.js";
import { requireSsoManager, type SsoActor } from "../src/engine/sso/guard.js";
import {
  createSetupLink,
  getSetupLink,
  listSetupLinks,
  revokeSetupLink,
} from "../src/engine/sso/setup-links.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

const HOUR_MS = 3_600_000;
const LOG_METHODS = ["error", "info", "warn", "log", "debug"] as const;

beforeEach(() => {
  for (const m of LOG_METHODS) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * A memory engine with `sso.setup` on and an owner of acme who passes the
 * manager guard. The actor comes from the guard, as a route gets it.
 */
async function world(sso: Omit<SsoConfig, "dns"> = { oidc: true, setup: {} }) {
  const w = ssoAuth({
    sso: sso as SsoConfig,
    password: { hash: FAST, uniformSignUp: false },
  });
  const owner = await managerSession(w, "owner@acme.example", "acme");
  const actor = await guarded(w, owner.token, owner.org);
  return { w, owner, actor, org: owner.org };
}

/** The actor of the manager guard for the session of `token`, or the refusal code. */
async function guarded(w: ReturnType<typeof ssoAuth>, token: string, org: string) {
  const resolved = await resolveSession(w.config, token);
  if (!resolved) throw new Error("the session ended");
  const r = await requireSsoManager(w.config, resolved, org);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** A valid mint input for `organizationId`. */
const input = (organizationId: string) => ({
  organizationId,
  steps: ["domain", "connection"] as ("domain" | "connection" | "directory")[],
  kinds: ["oidc"] as ("oidc" | "saml")[],
  note: "Ada at Acme IT",
});

/** Mints one link and answers its id and token, or throws. */
async function mint(
  w: ReturnType<typeof ssoAuth>,
  actor: SsoActor,
  organizationId: string,
  ttlHours?: number,
) {
  const made = await createSetupLink(w.config, actor, { ...input(organizationId), ttlHours });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  return made.value;
}

const linkRow = (w: ReturnType<typeof ssoAuth>, id: string) =>
  w.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: id }]);

/**
 * A live setup session of a link, as the open of Task 3 writes it: 60
 * minutes from the open, inside the 8 hours of the absolute end.
 */
async function openSession(w: ReturnType<typeof ssoAuth>, linkId: string, org: string) {
  const now = w.clock.now();
  return w.storage.create("ssoSetupSession", {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    linkId,
    organizationId: org,
    tokenHash: await sha256Hex(`session-of-${linkId}`),
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + HOUR_MS),
    endedAt: null,
  });
}

describe("the SSO setup links (plan 13a Task 2)", () => {
  it("mints an sl_ token, stores its SHA-256 hex, and writes it to no audit row and no log line", async () => {
    const { w, actor, org, owner } = await world();
    const made = await mint(w, actor, org);
    expect(made.token).toMatch(/^sl_[A-Za-z0-9_-]{43}$/);
    const row = await linkRow(w, made.id);
    expect(row).toMatchObject({
      organizationId: org,
      tokenHash: await sha256Hex(made.token),
      hint: made.token.slice(3, 11),
      steps: ["domain", "connection"],
      kinds: ["oidc"],
      note: "Ada at Acme IT",
      createdBy: owner.user.id,
      revokedAt: null,
      endedAt: null,
      openedAt: null,
      readyAt: null,
    });
    const audit = JSON.stringify(await w.storage.findMany("operatorAudit", []));
    expect(audit).not.toContain(made.token);
    expect(audit).not.toContain(row?.tokenHash);
    for (const m of LOG_METHODS)
      for (const call of vi.mocked(console[m]).mock.calls)
        expect(JSON.stringify(call)).not.toContain(made.token);
  });

  it("refuses a third live link with 409 setup_link_limit", async () => {
    const { w, actor, org } = await world();
    await mint(w, actor, org);
    await mint(w, actor, org);
    const third = await createSetupLink(w.config, actor, input(org));
    expect(third).toEqual({ ok: false, code: "setup_link_limit", status: 409 });
    expect(await w.storage.findMany("ssoSetupLink", [])).toHaveLength(2);
  });

  it("does not count a revoked or an expired link against the limit", async () => {
    const { w, actor, org } = await world();
    const expired = await mint(w, actor, org, 1);
    const revoked = await mint(w, actor, org);
    expect(await revokeSetupLink(w.config, actor, revoked.id)).toEqual({
      ok: true,
      value: undefined,
    });
    w.clock.advance(HOUR_MS);
    expect((await linkRow(w, expired.id))?.expiresAt.getTime()).toBe(w.clock.now().getTime());
    await mint(w, actor, org);
    const next = await createSetupLink(w.config, actor, input(org));
    expect(next.ok).toBe(true);
  });

  it("refuses a kind that sso has not on with 400 invalid_body", async () => {
    const { w, actor, org } = await world({ oidc: true, setup: {} });
    const r = await createSetupLink(w.config, actor, { ...input(org), kinds: ["saml"] });
    expect(r).toMatchObject({ ok: false, code: "invalid_body", status: 400 });
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
  });

  it("refuses a note of 0 and of 81 characters with 400, and takes 80", async () => {
    const { w, actor, org } = await world();
    for (const note of ["", "x".repeat(81)]) {
      const r = await createSetupLink(w.config, actor, { ...input(org), note });
      expect(r).toMatchObject({ ok: false, code: "invalid_body", status: 400 });
    }
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
    const r = await createSetupLink(w.config, actor, { ...input(org), note: "x".repeat(80) });
    expect(r.ok).toBe(true);
  });

  it("sets expiresAt 72 hours ahead of the clock when the input has no ttlHours", async () => {
    const { w, actor, org } = await world();
    const made = await mint(w, actor, org);
    const at = new Date(w.clock.now().getTime() + 72 * HOUR_MS);
    expect(made.expiresAt).toEqual(at);
    expect((await linkRow(w, made.id))?.expiresAt).toEqual(at);
  });

  it("answers 403 forbidden_rank to a member of a lower rank, and writes no row", async () => {
    const { w, actor, org, owner } = await world();
    const second = await verifiedSession(w, "second@acme.example");
    const added = await addMember(w.config, {
      user: owner.user,
      organizationId: org,
      userId: second.user.id,
      role: "owner",
    });
    expect(added.ok).toBe(true);
    // The second owner demotes the first after the guard gave the actor.
    const demoted = await updateMemberRole(w.config, {
      user: second.user,
      organizationId: org,
      userId: owner.user.id,
      role: "admin",
    });
    expect(demoted.ok).toBe(true);
    const r = await createSetupLink(w.config, actor, input(org));
    expect(r).toEqual({ ok: false, code: "forbidden_rank", status: 403 });
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
    expect(await w.storage.findMany("operatorAudit", [])).toEqual([]);
    expect(await listSetupLinks(w.config, actor, org)).toEqual({
      ok: false,
      code: "forbidden_rank",
      status: 403,
    });
  });

  it("answers 403 forbidden_rank to an owner of another organization who revokes or gets a link", async () => {
    const { w, actor, org } = await world();
    const made = await mint(w, actor, org);
    const other = await managerSession(w, "owner@bexley.example", "bexley");
    const foreign = await guarded(w, other.token, other.org);
    const refused = { ok: false, code: "forbidden_rank", status: 403 };
    expect(await revokeSetupLink(w.config, foreign, made.id)).toEqual(refused);
    expect(await getSetupLink(w.config, foreign, made.id)).toEqual(refused);
    expect((await linkRow(w, made.id))?.revokedAt).toBeNull();
    expect(
      await w.storage.findMany("operatorAudit", [
        { field: "action", op: "eq", value: "sso_setup_link_revoke" },
      ]),
    ).toEqual([]);
  });

  it("sets the link revokedAt and the session endedAt in one transaction", async () => {
    const { w, actor, org } = await world();
    const made = await mint(w, actor, org);
    const session = await openSession(w, made.id, org);
    const sessionRow = () =>
      w.storage.findOne("ssoSetupSession", [{ field: "id", op: "eq", value: session.id }]);
    // A write of the session that fails takes the link write back with it.
    const run = w.config.storage.transaction.bind(w.config.storage);
    const spy = vi.spyOn(w.config.storage, "transaction").mockImplementation((fn) =>
      run((tx) =>
        fn({
          ...tx,
          update: async (model, where, data) => {
            if (model === "ssoSetupSession") throw new Error("the session write fails");
            return tx.update(model, where, data);
          },
        } as StorageAdapter),
      ),
    );
    await expect(revokeSetupLink(w.config, actor, made.id)).rejects.toThrow(
      "the session write fails",
    );
    expect((await linkRow(w, made.id))?.revokedAt).toBeNull();
    expect((await sessionRow())?.endedAt).toBeNull();
    spy.mockRestore();
    w.clock.advance(1000);
    expect(await revokeSetupLink(w.config, actor, made.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect((await linkRow(w, made.id))?.revokedAt).toEqual(w.clock.now());
    expect((await sessionRow())?.endedAt).toEqual(w.clock.now());
  });

  it("writes one sso_setup_link_create row with linkId and organizationId in data", async () => {
    const { w, actor, org, owner } = await world();
    const made = await mint(w, actor, org);
    const rows = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "sso_setup_link_create" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "user",
      actorId: owner.user.id,
      targetUserId: null,
      data: { linkId: made.id, organizationId: org },
    });
  });

  it("lists and gets the links of an organization with no token and no hash", async () => {
    const { w, actor, org } = await world();
    const made = await mint(w, actor, org);
    const listed = await listSetupLinks(w.config, actor, org);
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value.map((l) => l.id)).toEqual([made.id]);
    const got = await getSetupLink(w.config, actor, made.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value).toEqual(listed.value[0]);
    expect(got.value).toMatchObject({ organizationId: org, note: "Ada at Acme IT" });
    const hash = (await linkRow(w, made.id))?.tokenHash ?? "";
    expect(JSON.stringify(listed.value)).not.toContain(hash);
    expect(JSON.stringify(listed.value)).not.toContain(made.token);
    expect(await getSetupLink(w.config, actor, "no-such-link")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("deletes the links and the setup sessions with the organization (ruling R6)", async () => {
    const { w, actor, org, owner } = await world();
    const made = await mint(w, actor, org);
    await openSession(w, made.id, org);
    const gone = await deleteOrganization(w.config, { user: owner.user, organizationId: org });
    expect(gone).toEqual({ ok: true, value: { ok: true } });
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
    expect(await w.storage.findMany("ssoSetupSession", [])).toEqual([]);
  });

  it("deletes the links and the setup sessions in the act of a solo owner's account delete", async () => {
    const { w, actor, org, owner } = await world();
    const made = await mint(w, actor, org);
    await openSession(w, made.id, org);
    const session = await resolveSession(w.config, owner.token);
    if (!session) throw new Error("the session ended");
    const done = await deleteAccount(w.config, { session, ip: null, userAgent: null });
    expect(done).toEqual({ ok: true, value: { ok: true } });
    // No sweep ran: the act itself took both models.
    expect(await w.storage.findMany("organization", [])).toEqual([]);
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
    expect(await w.storage.findMany("ssoSetupSession", [])).toEqual([]);
  });
});
