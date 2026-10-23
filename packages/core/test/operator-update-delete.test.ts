import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, ConfigError, resolveConfig } from "../src/config.js";
import { requestEmailChange } from "../src/engine/email-change.js";
import { inviteMember } from "../src/engine/invitations.js";
import type { NoticeMailInput } from "../src/engine/notices.js";
import { type OperatorActor, requireOperatorUser } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import { requestPasswordReset } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createApiToken } from "../src/engine/tokens.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { USER_CHILD_MODELS } from "../src/storage/sql.js";
import { BASE_URL, get, recordCredential } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture, secretActor } from "./operator-helpers.js";
import { enrolled, verifiedSession } from "./totp-helpers.js";

// The operator update and the operator delete (plan 12f2 Task 4, spec 26
// and 8.15). The users come from the sign-up flows: the operator create of
// Task 2 belongs to the second wave (ruling 1 of plan 12f2, Q1).

/** A secret with the scopes `users` and `delete`. */
const ERASURE = recordCredential("operator-erasure-0123456789abcdef-0123");
const ADA = "ada@example.com";
const REASON = { reason: "Ticket 4521", ip: "203.0.113.9", userAgent: "Support/1" };

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A platform operator from the flows (`operatorFixture`), the secret
 * `support` (`users`, `sessions`, `audit`), and the secret `erasure`
 * (`users`, `delete`). The hooks record the user updates and the session
 * ends; the notices go to `notices`.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const updates: string[] = [];
  const ended: { id: string; reason: string }[] = [];
  const notices: NoticeMailInput[] = [];
  const fixture = await operatorFixture({
    config: {
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users", "sessions", "audit"],
          },
          { name: "erasure", secretHash: await sha256Hex(ERASURE), scopes: ["users", "delete"] },
        ],
        users: true,
      },
      account: {
        notices: {
          mail: (input) => {
            notices.push(input);
            return { to: "x", subject: "Notice", text: input.event };
          },
        },
      },
      hooks: {
        user: {
          beforeUpdate: ({ patch, via }) =>
            void updates.push(`before:${via}:${Object.keys(patch)}`),
          afterUpdate: ({ user, via }) => void updates.push(`after:${via}:${user.name}`),
        },
        session: { afterEnd: ({ session, reason }) => void ended.push({ id: session.id, reason }) },
      },
      ...extra,
    },
  });
  const { auth } = fixture;
  const guarded = await requireOperatorUser(auth.config, fixture.operator);
  if (!guarded.ok) throw new Error(guarded.code);
  // The notices of the fixture (the factor enable) are not under test.
  notices.length = 0;
  return {
    ...fixture,
    api: operatorApi(auth.config).users,
    support: await secretActor(auth, OPERATOR_SECRETS.support),
    erasure: await secretActor(auth, ERASURE),
    asOperator: guarded.value as OperatorActor,
    updates,
    ended,
    notices,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const userOf = (w: World, id: string) =>
  w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);

const auditRows = (w: World, action: string) =>
  w.auth.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }]);

/** The rows of `model` that name the user. */
const childRows = (w: World, model: (typeof USER_CHILD_MODELS)[number], userId: string) =>
  w.auth.storage.findMany(model, [{ field: "userId", op: "eq", value: userId }] as never);

/** A solo organization of `user`, through the organization api. */
async function soloOrganization(w: World, user: UserRow, slug: string) {
  const made = await createOrganization(w.auth.config, { user, slug, name: slug });
  if (!made.ok) throw new Error(made.code);
  return made.value.organization;
}

describe("the operator update (plan 12f2 Task 4)", () => {
  it("updates the name and the image and records the field names", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const mails = w.auth.mail.length;
    w.updates.length = 0;
    const done = await w.api.update({
      actor: w.support,
      userId: ada.user.id,
      name: "Ada Lovelace",
      image: "https://img.example.com/ada.png",
      ...REASON,
    });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.user).toMatchObject({ id: ada.user.id, email: ADA, name: "Ada Lovelace" });
    const row = await userOf(w, ada.user.id);
    expect(row).toMatchObject({ name: "Ada Lovelace", image: "https://img.example.com/ada.png" });
    const audit = await auditRows(w, "user_update");
    expect(audit).toMatchObject([
      {
        id: done.value.auditId,
        actorKind: "secret",
        actorId: "support",
        targetUserId: ada.user.id,
        reason: "Ticket 4521",
        data: { fields: ["name", "image"] },
      },
    ]);
    expect(w.updates).toEqual(["before:operator:name,image", "after:operator:Ada Lovelace"]);
    // A name and an image are not credentials: no notice, no mail.
    expect(w.auth.mail.length).toBe(mails);
    expect(w.notices).toEqual([]);
  });

  it("clears the name with null", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    expect(
      (await w.api.update({ actor: w.support, userId: ada.user.id, name: "Ada", ...REASON })).ok,
    ).toBe(true);
    const done = await w.api.update({
      actor: w.support,
      userId: ada.user.id,
      name: null,
      ...REASON,
    });
    expect(done.ok).toBe(true);
    expect((await userOf(w, ada.user.id))?.name).toBeNull();
    expect((await auditRows(w, "user_update")).map((r) => r.data)).toEqual([
      { fields: ["name"] },
      { fields: ["name"] },
    ]);
  });

  it("refuses an update with no field, and changes no address", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const before = await userOf(w, ada.user.id);
    const refused = { ok: false, code: "invalid_body", status: 400 };
    expect(await w.api.update({ actor: w.support, userId: ada.user.id, ...REASON })).toEqual(
      refused,
    );
    // A JS caller can pass any key: only the name and the image count.
    const other = { email: "eve@example.com", emailVerified: false } as object;
    expect(
      await w.api.update({ actor: w.support, userId: ada.user.id, ...other, ...REASON }),
    ).toEqual(refused);
    expect(
      await w.api.update({ actor: w.support, userId: ada.user.id, name: "\u0000", ...REASON }),
    ).toEqual(refused);
    expect(
      await w.api.update({
        actor: w.support,
        userId: ada.user.id,
        image: "http://img.example.com/a.png",
        ...REASON,
      }),
    ).toEqual(refused);
    expect(await userOf(w, ada.user.id)).toEqual(before);
    expect(await auditRows(w, "user_update")).toEqual([]);
  });

  it("refuses a user actor on itself and on another platform operator", async () => {
    const w = await world();
    const self = w.asOperator.kind === "user" ? w.asOperator.user.id : "";
    const asked = { name: "Root" };
    for (const act of ["update", "delete"] as const) {
      const call = (actor: OperatorActor, userId: string) =>
        act === "update"
          ? w.api.update({ actor, userId, ...asked, ...REASON })
          : w.api.delete({ actor, userId, ...REASON });
      expect(await call(w.asOperator, self)).toEqual({
        ok: false,
        code: "operator_self",
        status: 409,
      });
      expect(await call(w.asOperator, w.root.id)).toEqual({
        ok: false,
        code: "operator_required",
        status: 403,
      });
    }
    // The delete refuses inside its transaction, after its lock (ruling 5 of
    // plan 12f2, L1): the lock write goes back, and no audit row stays.
    expect(await userOf(w, w.root.id)).toEqual(w.root);
    expect(await auditRows(w, "user_delete")).toEqual([]);
    // A secret acts on a platform operator.
    expect(
      (await w.api.update({ actor: w.support, userId: w.root.id, ...asked, ...REASON })).ok,
    ).toBe(true);
    expect((await w.api.delete({ actor: w.erasure, userId: self, ...REASON })).ok).toBe(true);
    expect(await userOf(w, self)).toBeNull();
  });

  it("answers not_found for an absent user and with the user tools off", async () => {
    const w = await world();
    expect(
      await w.api.update({ actor: w.support, userId: "nobody", name: "X", ...REASON }),
    ).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(await w.api.delete({ actor: w.erasure, userId: "nobody", ...REASON })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    // The secrets stay, and the user tools are off.
    const off = await world({
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users"],
          },
          { name: "erasure", secretHash: await sha256Hex(ERASURE), scopes: ["users", "delete"] },
        ],
      },
    });
    const ada = await verifiedSession(off.auth, ADA);
    const app = { kind: "app", name: "support-tool" } as const;
    expect(await off.api.update({ actor: app, userId: ada.user.id, name: "X", ...REASON })).toEqual(
      { ok: false, code: "not_found", status: 404 },
    );
    expect(await off.api.delete({ actor: app, userId: ada.user.id, ...REASON })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("answers conflict to an update that lost the lock", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    // A profile write of another request lands before each compare of the act.
    let rounds = 0;
    const storage = w.auth.storage as StorageAdapter;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          update: async (model, where, patch) => {
            if (model === "user" && where.some((c) => c.field === "updatedAt")) {
              rounds++;
              const row = await userOf(w, ada.user.id);
              if (!row) throw new Error("no user");
              await storage.update("user", [{ field: "id", op: "eq", value: ada.user.id }], {
                name: `Other ${rounds}`,
                updatedAt: new Date(row.updatedAt.getTime() + 1),
              });
            }
            return tx.update(model, where, patch);
          },
        }),
      );
    w.updates.length = 0;
    const answer = await w.api.update({
      actor: w.support,
      userId: ada.user.id,
      name: "Mine",
      ...REASON,
    });
    storage.transaction = transaction;
    expect(answer).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(rounds).toBe(5);
    expect(log.mock.calls).toEqual([["authtempo: operator update gave up", ada.user.id]]);
    // The hook ran once per round, with the row of that round; no afterUpdate.
    expect(w.updates).toEqual(Array(5).fill("before:operator:name"));
    expect((await userOf(w, ada.user.id))?.name).toBe("Other 5");
    expect(await auditRows(w, "user_update")).toEqual([]);
  });
});

describe("the operator delete (plan 12f2 Task 4)", () => {
  it("needs the delete scope", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    expect(await w.api.delete({ actor: w.support, userId: ada.user.id, ...REASON })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await userOf(w, ada.user.id)).not.toBeNull();
    expect(await auditRows(w, "user_delete")).toEqual([]);
  });

  it("refuses a secret with delete and no users at construction", async () => {
    const hash = await sha256Hex(ERASURE);
    const build = () =>
      resolveConfig({
        baseURL: BASE_URL,
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: createMemoryAdapter(),
        mail: { send: async () => {} },
        operator: { secrets: [{ name: "eraser", secretHash: hash, scopes: ["delete"] }] },
      });
    expect(build).toThrow(ConfigError);
    expect(build).toThrow(
      "operator.secrets[] entry eraser has the scope delete and not users; add users",
    );
  });

  it("deletes through the 12a rows", async () => {
    const w = await world();
    const { session: ada } = await enrolled(w.auth, ADA);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const live = await resolveSession(w.auth.config, ada.token);
    if (!live) throw new Error("no session");
    expect((await createApiToken(w.auth.config, { user: ada.user, name: "ci" })).ok).toBe(true);
    const solo = await soloOrganization(w, ada.user, "ada-solo");
    const shared = await soloOrganization(w, bob.user, "bob-co");
    const joined = await addMember(w.auth.config, {
      user: bob.user,
      organizationId: shared.id,
      userId: ada.user.id,
      role: "member",
    });
    if (!joined.ok) throw new Error(joined.code);
    const sent = await inviteMember(w.auth.config, {
      user: ada.user,
      organizationId: solo.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!sent.ok) throw new Error(sent.code);
    // Proofs in flight for the user id and for the address.
    expect(
      (await requestEmailChange(w.auth.config, { session: live, newEmail: "ada2@example.com" })).ok,
    ).toBe(true);
    expect((await requestPasswordReset(w.auth.config, { email: ADA, ip: null })).ok).toBe(true);
    const proofs = () =>
      w.auth.storage.findMany("verification", [
        { field: "identifier", op: "in", value: [ada.user.id, ADA] },
      ]);
    expect((await proofs()).length).toBeGreaterThanOrEqual(2);
    for (const model of [
      "session",
      "password",
      "apiToken",
      "totp",
      "secondFactor",
      "member",
    ] as const)
      expect((await childRows(w, model, ada.user.id)).length, model).toBeGreaterThan(0);

    const done = await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON });
    expect(done).toEqual({
      ok: true,
      value: { organizations: [solo.id], auditId: expect.any(String) },
    });
    expect(await userOf(w, ada.user.id)).toBeNull();
    for (const model of USER_CHILD_MODELS)
      expect(await childRows(w, model, ada.user.id), model).toEqual([]);
    expect(await proofs()).toEqual([]);
    expect(
      await w.auth.storage.findOne("organization", [{ field: "id", op: "eq", value: solo.id }]),
    ).toBeNull();
    expect(
      await w.auth.storage.findOne("invitation", [{ field: "id", op: "eq", value: sent.value.id }]),
    ).toBeNull();
    // Bob's organization stays, with Bob alone.
    const left = await w.auth.storage.findMany("member", [
      { field: "organizationId", op: "eq", value: shared.id },
    ]);
    expect(left.map((m) => m.userId)).toEqual([bob.user.id]);
    const rows = await auditRows(w, "user_delete");
    expect(rows).toMatchObject([
      {
        actorKind: "secret",
        actorId: "erasure",
        targetUserId: ada.user.id,
        reason: "Ticket 4521",
        data: { organizations: [solo.id] },
        ip: "203.0.113.9",
        userAgent: "Support/1",
      },
    ]);
    if (!done.ok) throw new Error(done.code);
    expect(rows[0]?.id).toBe(done.value.auditId);
    // No field of the row holds the address.
    expect(JSON.stringify(rows[0])).not.toContain("ada@");
  });

  it("keeps the account and writes no audit row on sole_owner", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const club = await soloOrganization(w, ada.user, "club");
    expect(
      (
        await addMember(w.auth.config, {
          user: ada.user,
          organizationId: club.id,
          userId: bob.user.id,
          role: "member",
        })
      ).ok,
    ).toBe(true);
    expect(await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON })).toEqual({
      ok: false,
      code: "sole_owner",
      status: 409,
    });
    expect(await userOf(w, ada.user.id)).not.toBeNull();
    expect(
      await w.auth.storage.findOne("organization", [{ field: "id", op: "eq", value: club.id }]),
    ).not.toBeNull();
    const members = await w.auth.storage.findMany("member", [
      { field: "organizationId", op: "eq", value: club.id },
    ]);
    expect(members.map((m) => m.userId).sort()).toEqual([ada.user.id, bob.user.id].sort());
    expect(await resolveSession(w.auth.config, ada.token)).not.toBeNull();
    expect(await auditRows(w, "user_delete")).toEqual([]);
  });

  it("never deletes the platform organization", async () => {
    const w = await world();
    const op = w.asOperator.kind === "user" ? w.asOperator.user.id : "";
    // The operator goes first; root then holds the platform organization alone.
    expect((await w.api.delete({ actor: w.erasure, userId: op, ...REASON })).ok).toBe(true);
    expect(await w.api.delete({ actor: w.erasure, userId: w.root.id, ...REASON })).toEqual({
      ok: false,
      code: "sole_owner",
      status: 409,
    });
    expect(
      await w.auth.storage.findOne("organization", [
        { field: "id", op: "eq", value: w.platformOrg.id },
      ]),
    ).not.toBeNull();
    expect(await userOf(w, w.root.id)).not.toBeNull();
    expect((await auditRows(w, "user_delete")).map((r) => r.targetUserId)).toEqual([op]);
  });

  it("answers operator_required, not sole_owner, to a user actor on a platform operator who is the last owner of the platform organization", async () => {
    // The operator rank is below the owner rank, so root alone owns the platform organization.
    const w = await world({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, operator: 4, owner: 5 },
      },
    });
    // The platform check comes before the rank rule (ruling 6 of plan 12f2).
    expect(await w.api.delete({ actor: w.asOperator, userId: w.root.id, ...REASON })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    // A secret meets the rank rule: root is the last owner.
    expect(await w.api.delete({ actor: w.erasure, userId: w.root.id, ...REASON })).toEqual({
      ok: false,
      code: "sole_owner",
      status: 409,
    });
    expect(await userOf(w, w.root.id)).not.toBeNull();
    expect(await auditRows(w, "user_delete")).toEqual([]);
  });

  it("answers invalid_body to a userId that is not a string", async () => {
    const w = await world();
    for (const userId of [42, null, undefined, { id: w.root.id }, [w.root.id]])
      expect(
        await w.api.delete({ actor: w.erasure, userId: userId as unknown as string, ...REASON }),
      ).toEqual({ ok: false, code: "invalid_body", status: 400 });
    expect(await userOf(w, w.root.id)).not.toBeNull();
    expect(await auditRows(w, "user_delete")).toEqual([]);
  });

  it("deletes without account.delete and without a fresh session of the target", async () => {
    const w = await world({ account: { delete: false } });
    const ada = await verifiedSession(w.auth, ADA);
    // Past every fresh window: the target's session is stale.
    w.auth.clock.advance(30 * 86_400_000);
    expect((await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON })).ok).toBe(
      true,
    );
    expect(await userOf(w, ada.user.id)).toBeNull();
    expect(
      await w.auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "account-delete" },
      ]),
    ).toEqual([]);
  });

  it("mails account_deleted with no IP and no user agent", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    expect((await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON })).ok).toBe(
      true,
    );
    expect(w.notices).toMatchObject([
      { event: "account_deleted", email: ADA, ip: null, userAgent: null },
    ]);
    const notice = w.auth.mail.filter((m) => m.text === "account_deleted");
    expect(notice.map((m) => m.to)).toEqual([ADA]);
  });

  it("ends every session with the reason account_deleted", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const second = await verifiedSession(w.auth, ADA);
    const ids = (await childRows(w, "session", ada.user.id)).map((s) => s.id).sort();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    w.ended.length = 0;
    expect((await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON })).ok).toBe(
      true,
    );
    expect(w.ended.map((e) => e.id).sort()).toEqual(ids);
    expect(new Set(w.ended.map((e) => e.reason))).toEqual(new Set(["account_deleted"]));
    // The old token opens nothing at the route.
    const handle = createRouter(w.auth.config, coreRoutes(w.auth.config));
    for (const token of [ada.token, second.token]) {
      const res = await handle(
        get("/auth/session", { cookie: `${w.auth.config.cookieName}=${token}` }),
      );
      expect(res.status).toBe(401);
    }
  });

  it("ends the sessions past the page at the sweep, and the doors refuse them first", async () => {
    // Every sign-in passes: the page, not the limit of the sign-in, is under test.
    const w = await world({ limiter: { allow: async () => true } });
    const tokens: string[] = [];
    for (let i = 0; i < 40; i++) tokens.push((await verifiedSession(w.auth, ADA)).token);
    const ada = await resolveSession(w.auth.config, tokens[0] ?? "");
    if (!ada) throw new Error("no session");
    // The sign-up link opened one more session.
    const all = (await childRows(w, "session", ada.user.id)).length;
    expect(all).toBe(41);
    w.ended.length = 0;
    expect((await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON })).ok).toBe(
      true,
    );
    const inCall = w.ended.length;
    expect(inCall).toBeGreaterThan(0);
    expect(inCall).toBeLessThan(41);
    const pending = await w.auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "session-end" },
      { field: "identifier", op: "eq", value: ada.user.id },
    ]);
    expect(pending.map((p) => p.data?.reason)).toEqual(["account_deleted"]);
    // The user row is gone, so each door refuses a left session before the sweep.
    for (const token of tokens) expect(await resolveSession(w.auth.config, token)).toBeNull();
    for (let i = 0; i < 20 && (await childRows(w, "session", ada.user.id)).length > 0; i++)
      await sweepExpired(w.auth.config);
    expect(await childRows(w, "session", ada.user.id)).toEqual([]);
    expect(w.ended.length).toBe(41);
    expect(new Set(w.ended.map((e) => e.id)).size).toBe(41);
    expect(new Set(w.ended.map((e) => e.reason))).toEqual(new Set(["account_deleted"]));
  });

  it("refuses no delete for the statements of a parallel invocation on the same adapter", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const solo = await soloOrganization(w, ada.user, "ada-solo");
    // Another request reads through the same adapter while the delete reads
    // the member rows. The meter of the adapter counts its 30 statements too
    // (ruling 4 of plan 12f2). The size check runs only on a store with a
    // per-invocation query limit (ruling 5), so this memory store claims one.
    const storage = w.auth.storage as StorageAdapter;
    storage.queryLimitPerInvocation = true;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          findMany: async (model, where, options) => {
            if (model === "member") for (let i = 0; i < 30; i++) await userOf(w, ada.user.id);
            return tx.findMany(model, where, options);
          },
        }),
      );
    const done = await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON });
    storage.transaction = transaction;
    expect(done).toEqual({
      ok: true,
      value: { organizations: [solo.id], auditId: expect.any(String) },
    });
    expect(await userOf(w, ada.user.id)).toBeNull();
  });

  it("refuses a delete that cannot fit its budget with delete_too_large on a store with a per-invocation query limit, and changes nothing", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await soloOrganization(w, ada.user, `solo-${i}`)).id);
    // D1 claims the limit (ruling 5 of plan 12f2). This memory store claims it too.
    (w.auth.storage as StorageAdapter).queryLimitPerInvocation = true;
    expect(await w.api.delete({ actor: w.erasure, userId: ada.user.id, ...REASON })).toEqual({
      ok: false,
      code: "delete_too_large",
      status: 409,
    });
    expect(await userOf(w, ada.user.id)).toMatchObject({ updatedAt: ada.user.updatedAt });
    const orgs = await w.auth.storage.findMany("organization", [
      { field: "id", op: "in", value: ids },
    ]);
    expect(orgs.length).toBe(3);
    expect(await resolveSession(w.auth.config, ada.token)).not.toBeNull();
    expect(await auditRows(w, "user_delete")).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  it("never refuses on size on memory, a store with no per-invocation query limit (ruling 5 of plan 12f2)", async () => {
    const w = await world();
    const ada = await verifiedSession(w.auth, ADA);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await soloOrganization(w, ada.user, `solo-${i}`)).id);
    expect(w.auth.storage.queryLimitPerInvocation).toBeUndefined();
    // A user actor has the smallest budget: 6 solo organizations pass it by far.
    expect(await w.api.delete({ actor: w.asOperator, userId: ada.user.id, ...REASON })).toEqual({
      ok: true,
      value: { organizations: expect.any(Array), auditId: expect.any(String) },
    });
    expect(await userOf(w, ada.user.id)).toBeNull();
    expect(
      await w.auth.storage.findMany("organization", [{ field: "id", op: "in", value: ids }]),
    ).toEqual([]);
  });
});
