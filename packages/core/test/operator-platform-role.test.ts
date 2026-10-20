import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { isPlatformOperator, type OperatorActor } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember, updateMemberRole } from "../src/engine/organizations.js";
import { passwordSignUp } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { d1Like } from "./d1-like.js";
import { get, post, seedPlatform, tokenFromMail } from "./helpers.js";
import {
  authorizeGet,
  consentPost,
  exchange,
  pkce,
  REDIRECT,
  RESOURCE,
  requestIdOf,
  SCOPES,
} from "./oauth-helpers.js";
import {
  OPERATOR_SECRETS,
  type OperatorAuth,
  operatorAuth,
  operatorFixture,
  secretActor,
} from "./operator-helpers.js";
import { PASSWORD, verifiedSession } from "./totp-helpers.js";

const APP: OperatorActor = { kind: "app", name: "support-tool" };
const EMAIL = "ada@example.com";
/** The back-channel logout URI of the test client (plan 12e Task 16). */
const BC = "https://client.example.com/backchannel";
const DAY_MS = 86_400_000;

/**
 * The engine view with member hooks that write one line per event. A line
 * holds the point, `via`, the role, and whether `by` is null. A role change
 * has no `via`, so its line holds `-`.
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
    const ended: string[] = [];
    const { auth, operator } = await operatorFixture({
      config: {
        hooks: {
          session: {
            afterEnd: ({ session, reason }) => {
              ended.push(`${session.id}:${reason}`);
            },
          },
        },
      },
    });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const cookie = { cookie: `${auth.config.cookieName}=${operator.token}` };
    expect((await handle(get("/auth/session", cookie))).status).toBe(200);
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: operator.user.id },
    ]);
    // The fixture leaves one session of the operator: the session of its sign-in.
    expect(sessions.map((s) => s.id)).toEqual([operator.session.id]);
    ended.length = 0;
    const revoked = await revoke(auth, operator.user.id);
    if (!revoked.ok) throw new Error(revoked.code);
    expect(await resolveSession(auth.config, operator.token)).toBeNull();
    expect((await handle(get("/auth/session", cookie))).status).toBe(401);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
    // One session.afterEnd with the reason operator for each session (ruling 2).
    expect([...ended].sort()).toEqual(sessions.map((s) => `${s.id}:operator`).sort());
  });

  it("deletes an expired session with no afterEnd event, and ends a live one with the reason operator", async () => {
    const ended: string[] = [];
    const auth = await operatorAuth({
      hooks: {
        session: {
          afterEnd: ({ session, reason }) => {
            ended.push(`${session.id}:${reason}`);
          },
        },
      },
    });
    const { platformOrg } = await seedPlatform(auth);
    const old = await verifiedSession(auth, EMAIL);
    expect((await grant(auth, old.user.id)).ok).toBe(true);
    // The sessions live 30 days: the first sign-in's rows end before the second's.
    auth.clock.advance(20 * DAY_MS);
    const live = await verifiedSession(auth, EMAIL);
    auth.clock.advance(11 * DAY_MS);
    const rows = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: old.user.id },
    ]);
    expect(rows.map((s) => s.id)).toContain(old.session.id);
    expect(rows.filter((s) => s.expiresAt > auth.clock.now()).map((s) => s.id)).toEqual([
      live.session.id,
    ]);
    ended.length = 0;
    auth.clock.advance(1);
    expect((await revoke(auth, old.user.id)).ok).toBe(true);
    // An ended row goes with no hook (plan 12a review L3).
    expect(ended).toEqual([`${live.session.id}:operator`]);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
    expect(await platformMember(auth, platformOrg.id, old.user.id)).toBeNull();
  });

  it("answers conflict for a grant whose user an account delete takes before the member insert", async () => {
    const auth = await operatorAuth();
    const { platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    // D1 has no lock: the delete runs inside the grant's open transaction,
    // just before its member insert. Only the read after the insert sees it.
    const d1 = d1Like(auth.config);
    const raw = d1.storage;
    const state: { deleted: unknown } = { deleted: null };
    const storage: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (model === "member" && state.deleted === null)
                state.deleted = await deleteAccount(d1, {
                  session: ada,
                  ip: null,
                  userAgent: null,
                });
              return tx.create(model, data);
            },
          }),
        ),
    };
    const answer = await operatorApi({ ...d1, storage }).platformRole.grant({
      actor: APP,
      userId: ada.user.id,
      reason: "New support hire",
      ip: null,
      userAgent: null,
    });
    expect(answer).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(state.deleted).toEqual({ ok: true, value: { ok: true } });
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toBeNull();
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("sends the back-channel logout of each linked client after the revoke", async () => {
    const posts: string[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(new URLSearchParams(String(init?.body)).get("logout_token") ?? "");
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const auth = await operatorAuth({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
        fetch: fetchFn,
      },
    });
    await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    expect((await grant(auth, ada.user.id)).ok).toBe(true);
    // The code exchange with an ID token links ada's session to the client (plan 12e Task 16).
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const reg = await handle(
      post("/auth/oauth/register", { redirect_uris: [REDIRECT], backchannel_logout_uri: BC }),
    );
    if (reg.status !== 201) throw new Error(`register answered ${reg.status}`);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const p = await pkce();
    const cookie = `${auth.config.cookieName}=${ada.token}`;
    const page = await handle(
      authorizeGet({ clientId, challenge: p.challenge, scope: "openid mcp:read" }, cookie),
    );
    const done = await handle(
      consentPost({ request_id: requestIdOf(await page.text()), decision: "allow" }, { cookie }),
    );
    const code = new URL(done.headers.get("location") ?? "").searchParams.get("code");
    if (!code) throw new Error("no code");
    expect((await handle(exchange(code, clientId, p.verifier))).status).toBe(200);
    expect(posts).toEqual([]);
    expect((await revoke(auth, ada.user.id)).ok).toBe(true);
    expect(posts.map((t) => decodeJwt(t).sid)).toEqual([ada.session.id]);
    expect(await auth.storage.findMany("oauthLogout", [])).toEqual([]);
  });

  it("changes no role and fires no member hook for a grant to a holder, and writes the audit row", async () => {
    const { auth, events } = await hooked();
    const { platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    expect((await grant(auth, ada.user.id)).ok).toBe(true);
    events.length = 0;
    auth.clock.advance(1);
    const again = await grant(auth, ada.user.id);
    if (!again.ok) throw new Error(again.code);
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toMatchObject({
      role: "operator",
    });
    expect(events).toEqual([]);
    const rows = await auth.storage.findMany("operatorAudit", [], {
      sort: { field: "id", dir: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual(["platform_role_grant", "platform_role_grant"]);
    expect(rows[1]?.id).toBe(again.value.auditId);
  });

  it("changes no row, ends no session, and fires no hook for a revoke of a non-holder, and writes the audit row", async () => {
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
    const revoked = await revoke(auth, ada.user.id);
    if (!revoked.ok) throw new Error(revoked.code);
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toMatchObject({
      role: "member",
    });
    expect(await resolveSession(auth.config, ada.token)).not.toBeNull();
    expect(events).toEqual([]);
    const rows = await auth.storage.findMany("operatorAudit", []);
    expect(rows.map((r) => [r.id, r.action])).toEqual([
      [revoked.value.auditId, "platform_role_revoke"],
    ]);
  });

  it("answers member_limit for a new member row in a full platform organization", async () => {
    const { auth, events } = await hooked({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
        limits: { membersPerOrganization: 1 },
      },
    });
    const { platformOrg } = await seedPlatform(auth);
    const ada = await verifiedSession(auth, EMAIL);
    expect(await grant(auth, ada.user.id)).toEqual({
      ok: false,
      code: "member_limit",
      status: 409,
    });
    expect(await platformMember(auth, platformOrg.id, ada.user.id)).toBeNull();
    expect(events).toEqual([]);
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
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
    const secret = await secretActor(auth, OPERATOR_SECRETS.support);
    expect((await revoke(auth, other.user.id, secret)).ok).toBe(true);
    expect(await isPlatformOperator(auth.config, other.user.id)).toBe(false);
  });

  it("answers not_found for a grant and a revoke with no platform organization", async () => {
    const auth = await operatorAuth();
    const ada = await verifiedSession(auth, EMAIL);
    const none = { ok: false, code: "not_found", status: 404 };
    expect(await grant(auth, ada.user.id)).toEqual(none);
    expect(await revoke(auth, ada.user.id)).toEqual(none);
    expect(await auth.storage.findMany("member", [])).toEqual([]);
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
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
