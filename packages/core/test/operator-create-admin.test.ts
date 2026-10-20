import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  matchOperatorSecret,
  type OperatorActor,
  requireOperatorUser,
} from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember } from "../src/engine/organizations.js";
import { requestPasswordReset, resetPassword } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { base32Decode } from "../src/primitives/totp.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { BASE_URL, seedPlatform, tokenFromMail } from "./helpers.js";
import {
  OPERATOR_SECRETS,
  type OperatorAuth,
  operatorAuth,
  operatorFixture,
  operatorHeader,
} from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { codeNow, PASSWORD, verifiedSession } from "./totp-helpers.js";

const ADMIN = "admin@example.com";
const APP: OperatorActor = { kind: "app", name: "setup-script" };

/** The secret actor of a request with the named secret, as the routes build it. */
async function secretActor(auth: OperatorAuth, secret: string): Promise<OperatorActor> {
  const request = new Request(`${BASE_URL}/auth/operator/users/create-admin`, {
    method: "POST",
    headers: operatorHeader(secret),
  });
  const entry = await matchOperatorSecret(auth.config, request);
  if (!entry) throw new Error("no secret matched");
  return { kind: "secret", name: entry.name, scopes: entry.scopes };
}

/** The engine view with user and member hooks that write one line per event. */
async function hooked(extra: Partial<AuthConfig> = {}) {
  const events: string[] = [];
  /** The action of each draft that `hooks.operator.beforeAction` sees. */
  const actions: string[] = [];
  const auth = await operatorAuth({
    appName: "Acme",
    hooks: {
      user: {
        beforeCreate: (e) => {
          events.push(`user.beforeCreate:${e.via}:${e.user.emailVerified}`);
        },
        afterCreate: (e) => {
          events.push(`user.afterCreate:${e.via}`);
        },
        afterVerify: (e) => {
          events.push(`user.afterVerify:${e.via}`);
        },
      },
      operator: {
        beforeAction: (e) => {
          actions.push(e.audit.action);
        },
      },
      organization: {
        beforeAddMember: (e) => {
          events.push(`beforeAdd:${e.via}:${e.member.role}`);
        },
        afterAddMember: (e) => {
          events.push(`afterAdd:${e.via}:${e.member.role}`);
        },
      },
    },
    ...extra,
  });
  return { auth, events, actions };
}

const createAdmin = (
  auth: OperatorAuth,
  actor: OperatorActor,
  email = ADMIN,
  extra: { name?: string } = {},
) =>
  operatorApi(auth.config).createAdmin({
    actor,
    email,
    ...extra,
    reason: "First operator of the deployment",
    ip: "203.0.113.9",
    userAgent: "authtempo-cli/1",
  });

const userByEmail = (auth: OperatorAuth, email: string) =>
  auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);

const platform = (auth: OperatorAuth) =>
  auth.storage.findOne("organization", [{ field: "slug", op: "eq", value: "platform-co" }]);

describe("createAdmin (plan 12f Task 8)", () => {
  it("creates the platform organization and the first operator on a fresh database", async () => {
    const { auth, events } = await hooked();
    const actor = await secretActor(auth, OPERATOR_SECRETS.support);
    const made = await createAdmin(auth, actor, "  Admin@Example.COM ", { name: "Ada Admin" });
    if (!made.ok) throw new Error(made.code);
    expect(made.value.created).toBe(true);
    const org = await platform(auth);
    expect(org).toMatchObject({ slug: "platform-co", name: "Acme" });
    const user = await userByEmail(auth, ADMIN);
    expect(user).toMatchObject({ id: made.value.userId, emailVerified: false, name: "Ada Admin" });
    const members = await auth.storage.findMany("member", []);
    expect(members.map((m) => [m.organizationId, m.userId, m.role])).toEqual([
      [org?.id, made.value.userId, "owner,operator"],
    ]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    expect(await auth.storage.findMany("identity", [])).toEqual([]);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
    const rows = await auth.storage.findMany("operatorAudit", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: made.value.auditId,
      action: "create_admin",
      actorKind: "secret",
      actorId: "support",
      targetUserId: made.value.userId,
      data: { created: true, organizationCreated: true },
      ip: "203.0.113.9",
      userAgent: "authtempo-cli/1",
    });
    expect(events).toEqual([
      "user.beforeCreate:operator:false",
      "beforeAdd:operator:owner,operator",
      "user.afterCreate:operator",
      "afterAdd:operator:owner,operator",
    ]);
  });

  it("gives a created admin no power before a proof of the mailbox and a factor", async () => {
    const { auth, events } = await hooked();
    const made = await createAdmin(auth, APP);
    if (!made.ok) throw new Error(made.code);
    // Before the sign-in: the address is not proved, and no credential exists.
    expect(await userByEmail(auth, ADMIN)).toMatchObject({ emailVerified: false });
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
    events.length = 0;
    // The first proof of the mailbox: a magic link claims the address.
    await requestMagicLink(auth.config, { email: ADMIN, ip: null });
    const link = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!link.ok || !("token" in link.value)) throw new Error("no session");
    expect(events).toEqual(["user.afterVerify:magic_link"]);
    const signedIn = await resolveSession(auth.config, link.value.token);
    if (!signedIn) throw new Error("no session");
    expect(signedIn.user.emailVerified).toBe(true);
    expect(await requireOperatorUser(auth.config, signedIn)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    // A password through the reset link, then TOTP through the enable flow.
    await requestPasswordReset(auth.config, { email: ADMIN, ip: null });
    const reset = await resetPassword(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!reset.ok || !("token" in reset.value)) throw new Error("the reset opened no session");
    const session = await resolveSession(auth.config, reset.value.token);
    if (!session) throw new Error("no session");
    const setup = await setupTotp(auth.config, { userId: made.value.userId, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    const enabled = await enableTotp(auth.config, {
      session,
      code: await codeNow(auth, base32Decode(setup.value.secret)),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    const live = await resolveSession(auth.config, reset.value.token);
    if (!live) throw new Error("no session");
    const guard = await requireOperatorUser(auth.config, live);
    expect(guard.ok && guard.value.user.id).toBe(made.value.userId);
  });

  it("adds the role to an existing user and answers created false", async () => {
    const { auth, events } = await hooked();
    const { root, platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, "ada@example.com");
    const bea = await verifiedSession(auth, "bea@example.com");
    const added = await addMember(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: bea.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    events.length = 0;
    const a = await createAdmin(auth, APP, "ada@example.com");
    // A ULID of a later millisecond sorts after, so the rows read in order.
    auth.clock.advance(1);
    const b = await createAdmin(auth, APP, "bea@example.com");
    if (!a.ok || !b.ok) throw new Error("createAdmin failed");
    expect([a.value.created, a.value.userId]).toEqual([false, ada.user.id]);
    expect([b.value.created, b.value.userId]).toEqual([false, bea.user.id]);
    const roles = await auth.storage.findMany("member", [
      { field: "organizationId", op: "eq", value: platformOrg.id },
    ]);
    expect(new Map(roles.map((m) => [m.userId, m.role]))).toEqual(
      new Map([
        [root.id, "owner,operator"],
        [ada.user.id, "operator"],
        [bea.user.id, "member,operator"],
      ]),
    );
    expect(await auth.storage.findMany("organization", [])).toHaveLength(1);
    expect(events).toEqual(["beforeAdd:operator:operator", "afterAdd:operator:operator"]);
    const rows = await auth.storage.findMany("operatorAudit", [], {
      sort: { field: "id", dir: "asc" },
    });
    expect(rows.map((r) => [r.targetUserId, r.data])).toEqual([
      [ada.user.id, { created: false, organizationCreated: false }],
      [bea.user.id, { created: false, organizationCreated: false }],
    ]);
    // A second call changes no row, and its audit row still records the act.
    const again = await createAdmin(auth, APP, "ada@example.com");
    expect(again.ok && again.value.created).toBe(false);
    expect(await auth.storage.findMany("member", [])).toHaveLength(3);
    expect(await auth.storage.findMany("operatorAudit", [])).toHaveLength(3);
  });

  it("refuses a banned user with account_banned", async () => {
    const { auth, actions } = await hooked();
    const ada = await verifiedSession(auth, "ada@example.com");
    const banned = await operatorApi(auth.config).users.ban({
      actor: APP,
      userId: ada.user.id,
      reason: "Abuse report 7",
      ip: null,
      userAgent: null,
    });
    if (!banned.ok) throw new Error(banned.code);
    actions.length = 0;
    expect(await createAdmin(auth, APP, "ada@example.com")).toEqual({
      ok: false,
      code: "account_banned",
      status: 403,
    });
    // The read before the act refuses: no hook sees the act.
    expect(actions).toEqual([]);
    expect(await platform(auth)).toBeNull();
    expect(await auth.storage.findMany("member", [])).toEqual([]);
    const rows = await auth.storage.findMany("operatorAudit", []);
    expect(rows.map((r) => r.action)).toEqual(["ban"]);
  });

  it("refuses a ban or a new user that commits between the read and the act", async () => {
    const { auth, actions } = await hooked();
    const ada = await verifiedSession(auth, "ada@example.com");
    // Two parallel requests: a ban, or a sign-up at the address, commits
    // after the read of createAdmin and before its transaction.
    const storage = auth.storage as StorageAdapter;
    const transaction = storage.transaction.bind(storage);
    let between: (() => Promise<unknown>) | null = null;
    storage.transaction = async (fn) => {
      const step = between;
      between = null;
      if (step) await step();
      return transaction(fn);
    };
    between = () =>
      operatorApi(auth.config).users.ban({
        actor: APP,
        userId: ada.user.id,
        reason: "Abuse report 7",
        ip: null,
        userAgent: null,
      });
    expect(await createAdmin(auth, APP, "ada@example.com")).toEqual({
      ok: false,
      code: "account_banned",
      status: 403,
    });
    between = () => verifiedSession(auth, "bea@example.com");
    expect(await createAdmin(auth, APP, "bea@example.com")).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    // The ban's own act runs inside the step, after the draft of the first call.
    expect(actions).toEqual(["create_admin", "ban", "create_admin"]);
    expect(await platform(auth)).toBeNull();
    expect(await auth.storage.findMany("member", [])).toEqual([]);
    const rows = await auth.storage.findMany("operatorAudit", []);
    expect(rows.map((r) => r.action)).toEqual(["ban"]);
    // A parallel createAdmin makes the platform organization after the read.
    between = () => createAdmin(auth, APP, "root@example.com");
    expect(await createAdmin(auth, APP)).toEqual({ ok: false, code: "conflict", status: 409 });
    const root = await userByEmail(auth, "root@example.com");
    const org = await platform(auth);
    const members = await auth.storage.findMany("member", []);
    expect(members.map((m) => [m.organizationId, m.userId, m.role])).toEqual([
      [org?.id, root?.id, "owner,operator"],
    ]);
    expect(await userByEmail(auth, ADMIN)).toBeNull();
    const after = await auth.storage.findMany("operatorAudit", []);
    expect(after.map((r) => [r.action, r.targetUserId, r.data])).toEqual([
      ["ban", ada.user.id, { until: null }],
      ["create_admin", root?.id, { created: true, organizationCreated: true }],
    ]);
  });

  it("refuses a user actor, a bad address, and a bad name", async () => {
    const { auth, operator } = await operatorFixture();
    const user: OperatorActor = { kind: "user", user: operator.user, session: operator.session };
    expect(await createAdmin(auth, user)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await createAdmin(auth, APP, "not an address")).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    expect(await createAdmin(auth, APP, ADMIN, { name: "a\nb" })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    const audit: OperatorActor = { kind: "secret", name: "audit", scopes: ["audit"] };
    expect(await createAdmin(auth, audit)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await userByEmail(auth, ADMIN)).toBeNull();
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("is off with no platformRole or no operator.users", async () => {
    const noRole = await operatorAuth({
      organizations: { ranks: { viewer: 1, member: 2, admin: 3, owner: 4 } },
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users"],
          },
        ],
        users: true,
      },
    });
    const noUsers = await operatorAuth({
      operator: {
        secrets: [
          {
            name: "keys",
            secretHash: await sha256Hex(OPERATOR_SECRETS.keys),
            scopes: ["keys", "secrets"],
          },
        ],
      },
    });
    const off = { ok: false, code: "not_found", status: 404 };
    for (const auth of [noRole, noUsers]) {
      const ada = await verifiedSession(auth, "ada@example.com");
      const api = operatorApi(auth.config);
      const act = { actor: APP, reason: "Setup", ip: null, userAgent: null };
      expect(await api.createAdmin({ ...act, email: ADMIN })).toEqual(off);
      expect(await api.platformRole.grant({ ...act, userId: ada.user.id })).toEqual(off);
      expect(await api.platformRole.revoke({ ...act, userId: ada.user.id })).toEqual(off);
      expect(await userByEmail(auth, ADMIN)).toBeNull();
      expect(await auth.storage.findMany("member", [])).toEqual([]);
      expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
    }
  });

  it("keeps the role owner alone when the platform role is owner", async () => {
    const auth = await operatorAuth({
      password: { hash: FAST, uniformSignUp: false },
      organizations: {
        platformRole: "owner",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4 },
      },
    });
    const made = await createAdmin(auth, APP);
    if (!made.ok) throw new Error(made.code);
    const members = await auth.storage.findMany("member", []);
    expect(members.map((m) => m.role)).toEqual(["owner"]);
  });
});
