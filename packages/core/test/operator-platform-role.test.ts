import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { isPlatformOperator, type OperatorActor } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember, updateMemberRole } from "../src/engine/organizations.js";
import { passwordSignUp } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { get, seedPlatform, tokenFromMail } from "./helpers.js";
import { type OperatorAuth, operatorAuth, operatorFixture } from "./operator-helpers.js";
import { PASSWORD, verifiedSession } from "./totp-helpers.js";

const APP: OperatorActor = { kind: "app", name: "support-tool" };
const EMAIL = "ada@example.com";

/**
 * The engine view with member hooks that write one line per event: the
 * point, `via` (or `-` for a role change, which has none), the role, and
 * whether `by` is null.
 */
async function hooked(extra: Partial<AuthConfig> = {}) {
  const events: string[] = [];
  const by = (e: { by: unknown }) => (e.by === null ? "app" : "user");
  const auth = await operatorAuth({
    hooks: {
      organization: {
        beforeAddMember: (e) => {
          events.push(`beforeAdd:${e.via}:${e.member.role}:${by(e)}`);
        },
        afterAddMember: (e) => {
          events.push(`afterAdd:${e.via}:${e.member.role}:${by(e)}`);
        },
        beforeUpdateMemberRole: (e) => {
          events.push(`beforeRole:-:${e.member.role}>${e.role}:${by(e)}`);
        },
        afterUpdateMemberRole: (e) => {
          events.push(`afterRole:-:${e.previousRole}>${e.member.role}:${by(e)}`);
        },
        beforeRemoveMember: (e) => {
          events.push(`beforeRemove:${e.via}:${e.member.role}:${by(e)}`);
        },
        afterRemoveMember: (e) => {
          events.push(`afterRemove:${e.via}:${e.member.role}:${by(e)}`);
        },
      },
    },
    ...extra,
  });
  return { auth, events, api: operatorApi(auth.config) };
}

const grant = (auth: OperatorAuth, userId: string, actor: OperatorActor = APP) =>
  operatorApi(auth.config).platformRole.grant({
    actor,
    userId,
    reason: "New support hire",
    ip: "203.0.113.9",
    userAgent: "Support/1",
  });

const revoke = (auth: OperatorAuth, userId: string, actor: OperatorActor = APP) =>
  operatorApi(auth.config).platformRole.revoke({
    actor,
    userId,
    reason: "Left the support team",
    ip: "203.0.113.9",
    userAgent: "Support/1",
  });

/** The member row of `userId` in the platform organization, or null. */
const platformMember = (auth: OperatorAuth, organizationId: string, userId: string) =>
  auth.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);

describe("the platform role (plan 12f Task 8)", () => {
  it("grants and revokes the platform role with the member hooks", async () => {
    const { auth, events } = await hooked();
    const { platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    const granted = await grant(auth, ada.user.id);
    if (!granted.ok) throw new Error(granted.code);
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toMatchObject({
      role: "operator",
    });
    expect(await isPlatformOperator(auth.config, ada.user.id)).toBe(true);
    expect(events).toEqual(["beforeAdd:operator:operator:app", "afterAdd:operator:operator:app"]);
    // A ULID of a later millisecond sorts after, so the rows read in order.
    auth.clock.advance(1);
    const revoked = await revoke(auth, ada.user.id);
    if (!revoked.ok) throw new Error(revoked.code);
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toBeNull();
    expect(await isPlatformOperator(auth.config, ada.user.id)).toBe(false);
    expect(events.slice(2)).toEqual([
      "beforeRemove:operator:operator:app",
      "afterRemove:operator:operator:app",
    ]);
    const rows = await auth.storage.findMany("operatorAudit", [], {
      sort: { field: "id", dir: "asc" },
    });
    expect(rows.map((r) => [r.id, r.action, r.actorKind, r.actorId, r.targetUserId])).toEqual([
      [granted.value.auditId, "platform_role_grant", "app", "support-tool", ada.user.id],
      [revoked.value.auditId, "platform_role_revoke", "app", "support-tool", ada.user.id],
    ]);
  });

  it("adds the role part to a member row and removes only that part", async () => {
    const { auth, events } = await hooked();
    const { root, platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    const added = await addMember(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: ada.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    events.length = 0;
    expect((await grant(auth, ada.user.id)).ok).toBe(true);
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toMatchObject({
      role: "member,operator",
    });
    expect((await revoke(auth, ada.user.id)).ok).toBe(true);
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toMatchObject({
      role: "member",
    });
    expect(events).toEqual([
      "beforeRole:-:member>member,operator:app",
      "afterRole:-:member>member,operator:app",
      "beforeRole:-:member,operator>member:app",
      "afterRole:-:member,operator>member:app",
    ]);
  });

  it("ends the sessions of a revoked operator at once", async () => {
    const { auth, operator } = await operatorFixture();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const cookie = { cookie: `${auth.config.cookieName}=${operator.token}` };
    expect((await handle(get("/auth/session", cookie))).status).toBe(200);
    const revoked = await revoke(auth, operator.user.id);
    if (!revoked.ok) throw new Error(revoked.code);
    expect(await resolveSession(auth.config, operator.token)).toBeNull();
    expect((await handle(get("/auth/session", cookie))).status).toBe(401);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
  });

  it("keeps the last owner of the platform organization", async () => {
    const auth = await operatorAuth();
    const { root, platformOrg } = await seedPlatform(auth);
    // Root leaves the owner part. The operator rank (5) is above the owner
    // rank (4), so the role "operator" alone still makes root the one owner.
    const moved = await updateMemberRole(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: root.id,
      role: "operator",
    });
    if (!moved.ok) throw new Error(moved.code);
    // Root has no password: the seed wrote the user. A magic link signs in.
    await requestMagicLink(auth.config, { email: root.email, ip: null });
    const link = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!link.ok || !("token" in link.value)) throw new Error("no session");
    const rootSession = link.value;
    const answer = await revoke(auth, root.id);
    expect(answer).toEqual({ ok: false, code: "last_owner", status: 409 });
    expect(await platformMember(auth, platformOrg.id, root.id)).toMatchObject({
      role: "operator",
    });
    expect(await resolveSession(auth.config, rootSession.token)).not.toBeNull();
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
    // A rest below the owner rank also leaves no owner: "member" stays of "member,operator".
    const member = await updateMemberRole(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: root.id,
      role: "member,operator",
    });
    if (!member.ok) throw new Error(member.code);
    expect(await revoke(auth, root.id)).toEqual({ ok: false, code: "last_owner", status: 409 });
    expect(await platformMember(auth, platformOrg.id, root.id)).toMatchObject({
      role: "member,operator",
    });
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  /**
   * A revoke that a parallel role change races. The change commits after
   * the act reads the member row: the before hook writes the role outside
   * the act's transaction. `lock` revokes ada's role "operator", so the
   * owner lock guards the write. `plain` revokes root's part, and root
   * keeps the owner rank, so the plain write runs.
   */
  async function racedRevoke(path: "lock" | "plain") {
    const parallel = { userId: "", role: "" };
    const change = async () => {
      if (parallel.role === "") return;
      const role = parallel.role;
      parallel.role = "";
      await auth.storage.update("member", [{ field: "userId", op: "eq", value: parallel.userId }], {
        role,
      });
    };
    const auth = await operatorAuth({
      hooks: { organization: { beforeRemoveMember: change, beforeUpdateMemberRole: change } },
    });
    const { root, platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    expect((await grant(auth, ada.user.id)).ok).toBe(true);
    const target = path === "lock" ? ada.user.id : root.id;
    parallel.userId = target;
    parallel.role = path === "lock" ? "admin,operator" : "owner,operator,admin";
    const audited = (await auth.storage.findMany("operatorAudit", [])).length;
    const answer = await revoke(auth, target);
    return {
      answer,
      role: (await platformMember(auth, platformOrg.id, target))?.role,
      operator: await isPlatformOperator(auth.config, target),
      rows: (await auth.storage.findMany("operatorAudit", [])).length - audited,
      session: (await resolveSession(auth.config, ada.token)) !== null,
    };
  }

  it("answers conflict, keeps the role, writes no audit row, and ends no session when a role change races the revoke under the owner lock", async () => {
    expect(await racedRevoke("lock")).toEqual({
      answer: { ok: false, code: "conflict", status: 409 },
      role: "admin,operator",
      operator: true,
      rows: 0,
      session: true,
    });
  });

  it("answers conflict, keeps the role, and writes no audit row when a role change races the plain revoke", async () => {
    expect(await racedRevoke("plain")).toEqual({
      answer: { ok: false, code: "conflict", status: 409 },
      role: "owner,operator,admin",
      operator: true,
      rows: 0,
      session: true,
    });
  });

  it("refuses an unverified target", async () => {
    const { auth, events } = await hooked();
    const { platformOrg } = await seedPlatform(auth);
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    if (!user) throw new Error("no user");
    expect(user.emailVerified).toBe(false);
    expect(await grant(auth, user.id)).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
    expect(await platformMember(auth, platformOrg.id, user.id)).toBeNull();
    expect(events).toEqual([]);
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("refuses a banned target with account_banned", async () => {
    const auth = await operatorAuth();
    const { platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    const banned = await operatorApi(auth.config).users.ban({
      actor: APP,
      userId: ada.user.id,
      reason: "Abuse report 7",
      ip: null,
      userAgent: null,
    });
    if (!banned.ok) throw new Error(banned.code);
    expect(await grant(auth, ada.user.id)).toEqual({
      ok: false,
      code: "account_banned",
      status: 403,
    });
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toBeNull();
  });

  it("refuses a user actor on their own role and on another operator", async () => {
    const { auth, operator } = await operatorFixture();
    const actor: OperatorActor = { kind: "user", user: operator.user, session: operator.session };
    expect(await revoke(auth, operator.user.id, actor)).toEqual({
      ok: false,
      code: "operator_self",
      status: 409,
    });
    const other = await verifiedSession(auth, "bea@example.com");
    expect((await grant(auth, other.user.id)).ok).toBe(true);
    expect(await revoke(auth, other.user.id, actor)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await isPlatformOperator(auth.config, other.user.id)).toBe(true);
    // A secret with the scope users can revoke an operator.
    const secret: OperatorActor = { kind: "secret", name: "support", scopes: ["users"] };
    expect((await revoke(auth, other.user.id, secret)).ok).toBe(true);
    expect(await isPlatformOperator(auth.config, other.user.id)).toBe(false);
  });

  it("needs the scope users of a secret actor", async () => {
    const auth = await operatorAuth();
    await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    const audit: OperatorActor = { kind: "secret", name: "audit", scopes: ["audit"] };
    expect(await grant(auth, ada.user.id, audit)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await revoke(auth, ada.user.id, audit)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
  });
});
