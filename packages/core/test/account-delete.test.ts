import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteAccount } from "../src/engine/account-delete.js";
import { requestEmailChange } from "../src/engine/email-change.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { acceptInvitation, inviteMember } from "../src/engine/invitations.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import type { NoticeMailInput } from "../src/engine/notices.js";
import { DEVICE_GRANT } from "../src/engine/oauth-clients.js";
import {
  addMember,
  createOrganization,
  removeMember,
  updateMemberRole,
  updateOrganization,
} from "../src/engine/organizations.js";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "../src/engine/passkeys.js";
import {
  changePassword,
  passwordSignIn,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { reauthenticate } from "../src/engine/reauth.js";
import { enableEmailMethod } from "../src/engine/second-factor-methods.js";
import { destroySession, type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { createApiToken } from "../src/engine/tokens.js";
import { enableTotp, setupTotp, verifyTwoFactor } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { base32Decode } from "../src/primitives/totp.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { USER_CHILD_MODELS } from "../src/storage/sql.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { d1Like } from "./d1-like.js";
import { post, tokenFromMail } from "./helpers.js";
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
import { FAST } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, googleSignIn, socialAuth } from "./social-helpers.js";
import { codeNow, EMAIL, PASSWORD, verifiedSession } from "./totp-helpers.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PASSKEY = {
  rpID: "api.example.com",
  rpName: "Example",
  origins: ["https://api.example.com"],
};
const OAUTH = {
  resources: [RESOURCE],
  scopes: SCOPES,
  registration: { cimd: false, dynamic: true },
  device: {},
};
const NOTICE = "Security notice for your api.example.com account";

afterEach(() => {
  vi.restoreAllMocks();
});

function world(extra: NonNullable<Parameters<typeof socialAuth>[0]> = {}) {
  const jwtTokens: Record<string, FakeIdToken> = {};
  const auth = socialAuth(
    {
      password: { hash: FAST, uniformSignUp: false },
      organizations: {},
      passkey: PASSKEY,
      ...extra,
    },
    fakeJwt(jwtTokens),
  );
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, jwtTokens, handle, cookie };
}
type World = ReturnType<typeof world>;

const input = (session: ResolvedSession) => ({ session, ip: "1.1.1.1", userAgent: "Agent/1" });

/** The session of `token` as stored now. */
async function live(w: World, token: string): Promise<ResolvedSession> {
  const s = await resolveSession(w.auth.config, token);
  if (!s) throw new Error("no session");
  return s;
}

async function userOf(w: World, id: string): Promise<UserRow | null> {
  return w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);
}

/**
 * The child models of schema version 11 that no flow writes yet (plan 12e
 * Task 1). A seeded row would be a state the product cannot reach. Tasks 11,
 * 14, and 16 of plan 12e write the flows, and each one takes its model out
 * of this set. Task 11 took `oauthSubject` out: a pairwise grant writes it.
 * Task 14 took `oauthDevice` out: a device grant that the user approves writes it.
 */
const NO_FLOW_YET: ReadonlySet<(typeof USER_CHILD_MODELS)[number]> = new Set([
  "oauthSessionClient",
  "oauthLogout",
]);

/** The rows of `model` that name `userId`. */
function childRows(w: World, model: (typeof USER_CHILD_MODELS)[number], userId: string) {
  // Each model of the list has a `userId` field; the port's types cannot see that over a union.
  return w.auth.storage.findMany(model, [{ field: "userId", op: "eq", value: userId }] as never);
}

function organizationOf(w: World, id: string) {
  return w.auth.storage.findOne("organization", [{ field: "id", op: "eq", value: id }]);
}

function membersOf(w: World, organizationId: string) {
  return w.auth.storage.findMany("member", [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
}

async function organization(w: World, user: UserRow, slug: string) {
  const r = await createOrganization(w.auth.config, { user, slug, name: slug });
  if (!r.ok) throw new Error(r.code);
  return r.value.organization;
}

async function member(w: World, by: UserRow, organizationId: string, userId: string, role: string) {
  const r = await addMember(w.auth.config, { user: by, organizationId, userId, role });
  if (!r.ok) throw new Error(r.code);
}

async function addPasskey(w: World, user: UserRow) {
  const soft = await SoftAuthenticator.create({
    rpID: PASSKEY.rpID,
    origin: PASSKEY.origins[0] ?? "",
  });
  const options = await passkeyRegistrationOptions(w.auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(w.auth.config, {
    user,
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!added.ok) throw new Error(added.code);
}

/**
 * An OAuth consent and a refresh token of the session's user, through the
 * routes. `subject_type` pairwise also writes the user's `oauthSubject` row.
 */
async function oauthGrant(w: World, token: string, subjectType: "public" | "pairwise" = "public") {
  const reg = await w.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      client_name: "Test",
      subject_type: subjectType,
    }),
  );
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}`);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const p = await pkce();
  const cookie = `${w.auth.config.cookieName}=${token}`;
  const page = await w.handle(authorizeGet({ clientId, challenge: p.challenge }, cookie));
  if (page.status !== 200) throw new Error(`authorize answered ${page.status}`);
  const done = await w.handle(
    consentPost({ request_id: requestIdOf(await page.text()), decision: "allow" }, { cookie }),
  );
  const code = new URL(done.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("no code");
  const tokens = await w.handle(exchange(code, clientId, p.verifier));
  if (tokens.status !== 200) throw new Error(`the exchange answered ${tokens.status}`);
}

/** A device grant that the session's user approves, through the routes (plan 12e Task 14). */
async function deviceGrant(w: World, token: string) {
  const reg = await w.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", DEVICE_GRANT],
    }),
  );
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}`);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const formPost = (path: string, body: Record<string, string>, headers = {}) =>
    new Request(`https://api.example.com/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });
  const started = await w.handle(
    formPost("/oauth/device_authorization", {
      client_id: clientId,
      scope: "mcp:read",
      resource: RESOURCE,
    }),
  );
  const { user_code } = (await started.json()) as { user_code: string };
  const page = {
    cookie: `${w.auth.config.cookieName}=${token}`,
    origin: "https://api.example.com",
  };
  const done = await w.handle(formPost("/oauth/device", { user_code, decision: "allow" }, page));
  if (!(await done.text()).includes("The device is connected.")) throw new Error("no approval");
}

/**
 * Runs `write` on the raw store before the next `times` user writes inside
 * a transaction: a parallel write that lands between a read and the lock.
 */
function beforeUserWrite(w: World, write: () => Promise<unknown>, times = 1) {
  const store = w.auth.config.storage as StorageAdapter;
  const original = store.transaction.bind(store);
  let left = times;
  (store as { transaction: StorageAdapter["transaction"] }).transaction = ((fn) =>
    original((tx) =>
      fn({
        ...tx,
        update: async (model, where, data) => {
          if (model === "user" && left > 0) {
            left--;
            await write();
          }
          return tx.update(model, where, data);
        },
      }),
    )) as StorageAdapter["transaction"];
}

describe("the account delete (plan 12a, spec 8.15)", () => {
  it("deletes the user and every row that names it, takes a solo organization, and keeps a team", async () => {
    const events: string[] = [];
    const w = world({
      oauth: OAUTH,
      hooks: {
        user: {
          beforeDelete: (e) =>
            void events.push(`user.before:${e.user.email}:${e.organizations.join(",")}`),
          afterDelete: (e) => void events.push(`user.after:${e.user.email}`),
        },
        organization: {
          beforeDelete: (e) => void events.push(`org.before:${e.organization.slug}`),
          afterDelete: (e) => void events.push(`org.after:${e.organization.slug}`),
        },
        session: { afterEnd: (e) => void events.push(`end:${e.session.userId}:${e.reason}`) },
      },
    });
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    // A Google identity of the same address, and a passkey.
    await googleSignIn(w.auth, w.jwtTokens);
    await addPasskey(w, me.user);
    // The second factor, then a sign-in that trusts this device.
    const setup = await setupTotp(w.auth.config, { userId: me.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    const secret = base32Decode(setup.value.secret);
    const on = await enableTotp(w.auth.config, {
      session: await live(w, me.token),
      code: await codeNow(w.auth, secret),
    });
    if (!on.ok) throw new Error(on.code);
    w.auth.clock.advance(30_000);
    const pending = await passwordSignIn(w.auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!pending.ok || !("twoFactor" in pending.value)) throw new Error("no challenge");
    const second = await verifyTwoFactor(w.auth.config, {
      challenge: pending.value.twoFactor.challenge,
      code: await codeNow(w.auth, secret),
      trustDevice: true,
      ip: null,
    });
    if (!second.ok) throw new Error(second.code);
    expect((await createApiToken(w.auth.config, { user: me.user, name: "ci" })).ok).toBe(true);
    await oauthGrant(w, me.token);
    await oauthGrant(w, me.token, "pairwise");
    await deviceGrant(w, me.token);
    // A solo organization, a team of Bob's where the user is an admin, and an
    // organization of Bob's that invites the user's address.
    const solo = await organization(w, me.user, "ada-solo");
    const team = await organization(w, bob.user, "team");
    await member(w, bob.user, team.id, me.user.id, "admin");
    const club = await organization(w, bob.user, "club");
    const sent = await inviteMember(w.auth.config, {
      user: me.user,
      organizationId: team.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!sent.ok) throw new Error(sent.code);
    const toMe = await inviteMember(w.auth.config, {
      user: bob.user,
      organizationId: club.id,
      email: EMAIL,
      role: "member",
    });
    if (!toMe.ok) throw new Error(toMe.code);
    // Proofs in flight for the address and for the user id.
    await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    expect(
      (
        await requestEmailChange(w.auth.config, {
          session: await live(w, me.token),
          newEmail: "ada.new@example.com",
        })
      ).ok,
    ).toBe(true);
    // Every child model holds a row of the user, so each check below can fail.
    for (const model of USER_CHILD_MODELS.filter((m) => !NO_FLOW_YET.has(m)))
      expect((await childRows(w, model, me.user.id)).length, model).toBeGreaterThan(0);
    // A model of NO_FLOW_YET holds no row here. When a task's flow writes one, this fails,
    // and the task takes the model out of the set and into the loop above.
    for (const model of NO_FLOW_YET)
      expect(await childRows(w, model, me.user.id), model).toEqual([]);
    const proofs = () =>
      w.auth.storage.findMany("verification", [
        { field: "identifier", op: "in", value: [me.user.id, EMAIL] },
      ]);
    expect((await proofs()).length).toBeGreaterThanOrEqual(2);
    const sessions = await childRows(w, "session", me.user.id);
    events.length = 0;
    w.auth.mail.length = 0;

    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await userOf(w, me.user.id)).toBeNull();
    for (const model of USER_CHILD_MODELS)
      expect(await childRows(w, model, me.user.id), model).toEqual([]);
    expect(await proofs()).toEqual([]);
    expect(await organizationOf(w, solo.id)).toBeNull();
    expect(await membersOf(w, solo.id)).toEqual([]);
    expect((await membersOf(w, team.id)).map((m) => m.userId)).toEqual([bob.user.id]);
    // The user sent this invitation: it goes. The invitation to the address stays.
    const invitations = await w.auth.storage.findMany("invitation", [
      { field: "id", op: "in", value: [sent.value.id, toMe.value.id] },
    ]);
    expect(invitations.map((i) => i.id)).toEqual([toMe.value.id]);
    expect(await organizationOf(w, club.id)).not.toBeNull();
    expect(await resolveSession(w.auth.config, bob.token)).not.toBeNull();
    expect(await childRows(w, "password", bob.user.id)).toHaveLength(1);
    expect(events).toEqual([
      "org.before:ada-solo",
      `user.before:${EMAIL}:${solo.id}`,
      ...sessions.map(() => `end:${me.user.id}:account_deleted`),
      "org.after:ada-solo",
      `user.after:${EMAIL}`,
    ]);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(w.auth.mail).toHaveLength(1);
    expect(w.auth.mail[0]?.to).toBe(EMAIL);
    expect(w.auth.mail[0]?.subject).toBe(NOTICE);
    expect(w.auth.mail[0]?.text).toContain("Your account was deleted.");
    expect(w.auth.mail[0]?.text).toContain("IP address: 1.1.1.1.");
  });

  it("refuses the delete of a sole owner with other members and deletes nothing", async () => {
    const calls: string[] = [];
    const w = world({
      hooks: {
        user: { beforeDelete: () => void calls.push("user.before") },
        organization: { beforeDelete: () => void calls.push("org.before") },
      },
    });
    const me = await verifiedSession(w.auth);
    const solo = await organization(w, me.user, "ada-solo");
    const team = await organization(w, me.user, "team");
    const bob = await verifiedSession(w.auth, "bob@example.com");
    // Bob is an admin, not an owner: the user stays the only owner.
    await member(w, me.user, team.id, bob.user.id, "admin");
    const before = await userOf(w, me.user.id);
    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toEqual({
      ok: false,
      code: "sole_owner",
      status: 409,
    });
    expect(calls).toEqual([]);
    // The lock wrote, and the refusal undid it.
    expect(await userOf(w, me.user.id)).toEqual(before);
    for (const id of [solo.id, team.id]) expect(await organizationOf(w, id)).not.toBeNull();
    expect((await membersOf(w, team.id)).length).toBe(2);
    expect(await resolveSession(w.auth.config, me.token)).not.toBeNull();
    expect(w.auth.mail.filter((m) => m.subject === NOTICE)).toEqual([]);
  });

  it("keeps an organization with another owner and removes the membership", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const team = await organization(w, me.user, "team");
    const carol = await verifiedSession(w.auth, "carol@example.com");
    await member(w, me.user, team.id, carol.user.id, "owner");
    expect((await deleteAccount(w.auth.config, input(await live(w, me.token)))).ok).toBe(true);
    expect(await organizationOf(w, team.id)).not.toBeNull();
    expect((await membersOf(w, team.id)).map((m) => [m.userId, m.role])).toEqual([
      [carol.user.id, "owner"],
    ]);
  });

  it("passes after the person makes another member an owner", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const team = await organization(w, me.user, "team");
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await member(w, me.user, team.id, bob.user.id, "member");
    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toMatchObject({
      code: "sole_owner",
    });
    const role = await updateMemberRole(w.auth.config, {
      user: me.user,
      organizationId: team.id,
      userId: bob.user.id,
      role: "owner",
    });
    expect(role.ok).toBe(true);
    expect((await deleteAccount(w.auth.config, input(await live(w, me.token)))).ok).toBe(true);
    expect((await membersOf(w, team.id)).map((m) => m.userId)).toEqual([bob.user.id]);
  });

  it("removes a plain membership with no rank check, and keeps the organization", async () => {
    const w = world();
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const team = await organization(w, bob.user, "team");
    const me = await verifiedSession(w.auth);
    await member(w, bob.user, team.id, me.user.id, "member");
    expect((await deleteAccount(w.auth.config, input(await live(w, me.token)))).ok).toBe(true);
    expect((await membersOf(w, team.id)).map((m) => m.userId)).toEqual([bob.user.id]);
  });

  it("never deletes the platform organization: its last owner answers sole_owner, also alone", async () => {
    const w = world({ organizations: { platformOrganization: "platform" } });
    const me = await verifiedSession(w.auth);
    // The app seeds the platform organization (plan 6); the engine has no route that makes it.
    const now = w.auth.clock.now();
    const platform = await w.auth.storage.create("organization", {
      id: "org-platform",
      slug: "platform",
      name: "Platform",
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });
    await w.auth.storage.create("member", {
      id: "mem-platform",
      organizationId: platform.id,
      userId: me.user.id,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toMatchObject({
      code: "sole_owner",
    });
    // A second owner: the delete passes, and the organization stays.
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await member(w, me.user, platform.id, bob.user.id, "owner");
    expect((await deleteAccount(w.auth.config, input(await live(w, me.token)))).ok).toBe(true);
    expect(await organizationOf(w, platform.id)).not.toBeNull();
    expect((await membersOf(w, platform.id)).map((m) => m.userId)).toEqual([bob.user.id]);
  });

  it("a stale session answers session_not_fresh, counts no try, and deletes nothing", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(DAY);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    expect(allow).not.toHaveBeenCalled();
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("passes the second press after a re-authentication with the same session token (Review Focus 1)", async () => {
    // A two-day-old tab: the delete asks for a fresh session, the person
    // proves the password on the same token, and the same press passes.
    const w = world();
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(2 * DAY);
    const first = await w.handle(post("/auth/user/delete", {}, w.cookie(me.token)));
    expect({ status: first.status, body: await first.json() }).toEqual({
      status: 403,
      body: { error: "session_not_fresh" },
    });
    const proved = await w.handle(post("/auth/reauth", { password: PASSWORD }, w.cookie(me.token)));
    expect(proved.status).toBe(200);
    const second = await w.handle(post("/auth/user/delete", {}, w.cookie(me.token)));
    expect({ status: second.status, body: await second.json() }).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await userOf(w, me.user.id)).toBeNull();
  });

  it("answers not_found with account.delete false, counts no try, and serves no route", async () => {
    const w = world({ account: { delete: false } });
    const me = await verifiedSession(w.auth);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(await deleteAccount(w.auth.config, input(me))).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    expect(allow).not.toHaveBeenCalled();
    const res = await w.handle(post("/auth/user/delete", {}, w.cookie(me.token)));
    expect(res.status).toBe(404);
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("refuses an account.delete that is not a boolean", () => {
    expect(() => world({ account: { delete: "yes" as never } })).toThrow(
      "account.delete must be a boolean",
    );
  });

  it("allows 5 deletes per user in an hour, on a key of its own per user", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    // A sole owner: each try is refused, so the user stays to try again.
    const team = await organization(w, me.user, "team");
    await member(w, me.user, team.id, bob.user.id, "member");
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    const tryOne = async () => deleteAccount(w.auth.config, input(await live(w, me.token)));
    for (let i = 0; i < 5; i++) expect(await tryOne()).toMatchObject({ code: "sole_owner" });
    expect(await tryOne()).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(allow).toHaveBeenLastCalledWith(`user-delete:user:${me.user.id}`, {
      seconds: 3600,
      max: 5,
    });
    // Another user has a key of its own.
    expect((await deleteAccount(w.auth.config, input(await live(w, bob.token)))).ok).toBe(true);
    // 1 ms before the window of the first call ends, the key still refuses.
    w.auth.clock.advance(HOUR - 1);
    expect(await tryOne()).toMatchObject({ code: "rate_limited" });
    w.auth.clock.advance(1);
    expect(await tryOne()).toEqual({ ok: true, value: { ok: true } });
  });

  it("a refusal of user.beforeDelete deletes nothing and sends no notice", async () => {
    const w = world({
      hooks: {
        user: {
          beforeDelete: () => {
            throw hookRefusal("Cancel your plan first.");
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    const solo = await organization(w, me.user, "ada-solo");
    const before = await userOf(w, me.user.id);
    expect(await deleteAccount(w.auth.config, input(me))).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Cancel your plan first.",
    });
    expect(await userOf(w, me.user.id)).toEqual(before);
    expect(await organizationOf(w, solo.id)).not.toBeNull();
    expect(await resolveSession(w.auth.config, me.token)).not.toBeNull();
    expect(w.auth.mail.filter((m) => m.subject === NOTICE)).toEqual([]);
  });

  it("a refusal of organization.beforeDelete deletes nothing", async () => {
    const w = world({
      hooks: {
        organization: {
          beforeDelete: () => {
            throw hookRefusal("Export the team first.");
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    const solo = await organization(w, me.user, "ada-solo");
    expect(await deleteAccount(w.auth.config, input(me))).toMatchObject({
      code: "hook_refused",
      message: "Export the team first.",
    });
    expect(await userOf(w, me.user.id)).not.toBeNull();
    expect(await organizationOf(w, solo.id)).not.toBeNull();
  });

  it("a throw of user.beforeDelete answers hook_failed with one log line and no address", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({
      hooks: {
        user: {
          beforeDelete: () => {
            throw new Error(`the app failed for ${EMAIL}`);
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    expect(await deleteAccount(w.auth.config, input(me))).toMatchObject({ code: "hook_failed" });
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "user.beforeDelete", "Error"],
    ]);
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("a throw of user.afterDelete logs the user id and keeps the delete", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({
      hooks: {
        user: {
          afterDelete: () => {
            throw new Error(`the app failed for ${EMAIL}`);
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    expect((await deleteAccount(w.auth.config, input(me))).ok).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "user.afterDelete", me.user.id, "Error"],
    ]);
    expect(await userOf(w, me.user.id)).toBeNull();
    expect(w.auth.mail.filter((m) => m.subject === NOTICE)).toHaveLength(1);
  });

  it("refuses a proof session that ended, and deletes nothing", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const proof = await live(w, me.token);
    await destroySession(w.auth.config, me.token);
    expect(await deleteAccount(w.auth.config, input(proof))).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("refuses a fresh proof session past the absolute cap", async () => {
    // The deployment sets a cap of one day after the sign-in: the row's
    // expiry is later, and the cap ends it. A re-authentication an hour
    // before keeps it fresh.
    const w = world();
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(DAY - HOUR);
    const proved = await reauthenticate(w.auth.config, {
      session: await live(w, me.token),
      proof: { password: PASSWORD },
      ip: null,
    });
    if (!proved.ok) throw new Error(proved.code);
    const proof = await live(w, me.token);
    w.auth.clock.advance(HOUR);
    const capped = { ...w.auth.config, session: { ...w.auth.config.session, absoluteDays: 1 } };
    expect(proof.session.expiresAt.getTime()).toBeGreaterThan(w.auth.clock.now().getTime());
    expect(await deleteAccount(capped, input(proof))).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("reads the user row again after a parallel write, and the hooks and the notice get the new row", async () => {
    const seen: string[] = [];
    const w = world({
      hooks: { user: { beforeDelete: (e) => void seen.push(e.user.name ?? "") } },
    });
    const me = await verifiedSession(w.auth);
    beforeUserWrite(w, () =>
      w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
        name: "Parallel",
        updatedAt: new Date(w.auth.clock.now().getTime() + 5),
      }),
    );
    expect((await deleteAccount(w.auth.config, input(me))).ok).toBe(true);
    expect(seen).toEqual(["Parallel"]);
    expect(await userOf(w, me.user.id)).toBeNull();
  });

  it("answers conflict after 5 lost rounds, deletes nothing, runs no hook, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const w = world({ hooks: { user: { beforeDelete: () => void calls.push("before") } } });
    const me = await verifiedSession(w.auth);
    let n = 0;
    beforeUserWrite(
      w,
      () =>
        w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
          name: `Parallel ${n++}`,
          updatedAt: new Date(w.auth.clock.now().getTime() + n),
        }),
      5,
    );
    expect(await deleteAccount(w.auth.config, input(me))).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(n).toBe(5);
    expect(log.mock.calls).toEqual([["authtempo: account delete gave up", me.user.id]]);
    expect(calls).toEqual([]);
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("answers not_found when the user row goes between the session read and the lock", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    beforeUserWrite(w, () =>
      w.auth.storage.delete("user", [{ field: "id", op: "eq", value: me.user.id }]),
    );
    expect(await deleteAccount(w.auth.config, input(me))).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    expect(w.auth.mail.filter((m) => m.subject === NOTICE)).toEqual([]);
  });

  it("sends the notice to the address of the row it held, with no address in the log", async () => {
    const w = world({
      account: { notices: { mail: () => ({ to: "x", subject: "S", text: "T" }) } },
    });
    const me = await verifiedSession(w.auth);
    // The address moves after the session resolved: the proof holds the old row.
    beforeUserWrite(w, () =>
      w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
        email: "ada.moved@example.com",
        updatedAt: new Date(w.auth.clock.now().getTime() + 5),
      }),
    );
    expect((await deleteAccount(w.auth.config, input(me))).ok).toBe(true);
    const notices = w.auth.mail.filter((m) => m.subject === "S");
    expect(notices.map((m) => m.to)).toEqual(["ada.moved@example.com"]);
  });

  it("an owner removal that lands inside the delete's open transaction on D1 answers conflict", async () => {
    // D1 has no lock: the other owner leaves after the delete's owner lock
    // and before its member delete. The recount sees no owner and undoes.
    const w = world();
    const me = await verifiedSession(w.auth);
    const team = await organization(w, me.user, "team");
    const carol = await verifiedSession(w.auth, "carol@example.com");
    await member(w, me.user, team.id, carol.user.id, "owner");
    await member(
      w,
      me.user,
      team.id,
      (await verifiedSession(w.auth, "bob@example.com")).user.id,
      "member",
    );
    const d1 = d1Like(w.auth.config);
    const raw = d1.storage;
    let left: Awaited<ReturnType<typeof removeMember>> | null = null;
    const view: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            delete: async (model, where) => {
              if (model === "member" && left === null && where[0]?.field === "userId")
                left = await removeMember(d1, {
                  user: carol.user,
                  organizationId: team.id,
                  userId: carol.user.id,
                });
              return tx.delete(model, where);
            },
          }),
        ),
    };
    const config = { ...d1, storage: view };
    expect(await deleteAccount(config, input(await live(w, me.token)))).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(left).toEqual({ ok: true, value: { ok: true } });
    expect(await userOf(w, me.user.id)).not.toBeNull();
    const owners = (await membersOf(w, team.id)).filter((m) => m.role === "owner");
    expect(owners.map((m) => m.userId)).toEqual([me.user.id]);
  });

  it("a sign-in that read the user before the delete commits no session: the read after its insert", async () => {
    // The whole delete commits between the sign-in's user read and its
    // session insert. Both run on a D1-like view. The memory adapter runs
    // one transaction at a time, and its undo puts back a whole row, which
    // D1 and Postgres never do.
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const proof = await live(w, me.token);
    const d1 = d1Like(w.auth.config);
    const raw = d1.storage;
    let deleted: Awaited<ReturnType<typeof deleteAccount>> | null = null;
    const signInView: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (model === "session" && deleted === null)
                deleted = await deleteAccount(d1, input(proof));
              return tx.create(model, data);
            },
          }),
        ),
    };
    const signIn = { ...d1, storage: signInView };
    expect(await verifyMagicLink(signIn, { token, ip: null, userAgent: null })).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(deleted).toEqual({ ok: true, value: { ok: true } });
    expect(await userOf(w, me.user.id)).toBeNull();
    for (const model of USER_CHILD_MODELS)
      expect(await childRows(w, model, me.user.id), model).toEqual([]);
  });

  it("on D1 the delete removes the user row before the sessions, so a sign-in between them is undone", async () => {
    // D1 has no lock. The sign-in reads the user, then the delete runs up to
    // its session delete. Then the sign-in inserts its session and reads the
    // user row, which is gone already. Then the delete goes on.
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const proof = await live(w, me.token);
    const d1 = d1Like(w.auth.config);
    const raw = d1.storage;
    let paused: () => void = () => {};
    const atSessions = new Promise<void>((go) => {
      paused = go;
    });
    let resume: () => void = () => {};
    const goOn = new Promise<void>((go) => {
      resume = go;
    });
    const deleteView: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            delete: async (model, where) => {
              const n = await tx.delete(model, where);
              if (model === "session") {
                paused();
                await goOn;
              }
              return n;
            },
          }),
        ),
    };
    let deleting: Promise<Awaited<ReturnType<typeof deleteAccount>>> | null = null;
    const signInView: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (model === "session" && deleting === null) {
                deleting = deleteAccount({ ...d1, storage: deleteView }, input(proof));
                await atSessions;
              }
              return tx.create(model, data);
            },
          }),
        ),
    };
    const signedIn = await verifyMagicLink(
      { ...d1, storage: signInView },
      { token, ip: null, userAgent: null },
    );
    resume();
    expect(await deleting).toEqual({ ok: true, value: { ok: true } });
    expect(signedIn).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(await userOf(w, me.user.id)).toBeNull();
    for (const model of USER_CHILD_MODELS)
      expect(await childRows(w, model, me.user.id), model).toEqual([]);
  });

  it("serves the route: 200, and the session cookie is cleared", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const res = await w.handle(
      post("/auth/user/delete", {}, { ...w.cookie(me.token), "user-agent": "Agent/2" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual([
      `${w.auth.config.cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(await userOf(w, me.user.id)).toBeNull();
    expect(w.auth.mail.at(-1)?.text).not.toContain("Agent/2");
  });

  it("gives the notice builder the event, the address, the IP, and the user agent of the request", async () => {
    const built: NoticeMailInput[] = [];
    const w = world({
      account: {
        notices: {
          mail: (i) => {
            built.push(i);
            return { to: i.email, subject: "n", text: "n" };
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    const res = await w.handle(
      post(
        "/auth/user/delete",
        {},
        { ...w.cookie(me.token), "cf-connecting-ip": "5.6.7.8", "user-agent": "Agent/2" },
      ),
    );
    expect(res.status).toBe(200);
    expect(built).toEqual([
      {
        event: "account_deleted",
        email: EMAIL,
        ip: "5.6.7.8",
        userAgent: "Agent/2",
        appName: "api.example.com",
        at: w.auth.clock.now(),
      },
    ]);
  });

  it("clears the legacy cookie name too, and ends its session", async () => {
    const w = world();
    const legacy = w.auth.config.legacyCookieName;
    if (legacy === null) throw new Error("the default name has a legacy name");
    const me = await verifiedSession(w.auth);
    const other = await verifiedSession(w.auth, "bob@example.com");
    const res = await w.handle(
      post(
        "/auth/user/delete",
        {},
        { cookie: `${w.auth.config.cookieName}=${me.token}; ${legacy}=${other.token}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().map((c) => c.split(";")[0])).toEqual([
      `${w.auth.config.cookieName}=`,
      `${legacy}=`,
    ]);
    expect(await resolveSession(w.auth.config, other.token)).toBeNull();
  });

  it("answers each error row of the route, with the renewed cookie on a refusal", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const send = (body: unknown, headers: Record<string, string> = w.cookie(me.token)) =>
      w.handle(post("/auth/user/delete", body, headers));
    expect((await send({}, {})).status).toBe(401);
    expect((await send({}, { authorization: "Bearer tk_nope" })).status).toBe(401);
    for (const body of [{ password: PASSWORD }, [], "x", null]) {
      const res = await send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    const team = await organization(w, me.user, "team");
    await member(
      w,
      me.user,
      team.id,
      (await verifiedSession(w.auth, "bob@example.com")).user.id,
      "member",
    );
    const owner = await send({});
    expect(owner.status).toBe(409);
    expect(await owner.json()).toEqual({ error: "sole_owner" });
    // Past the sliding refresh and the fresh window: the read renews the cookie, and the answer carries it.
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const stale = await send({});
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "session_not_fresh" });
    expect(
      stale.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${w.auth.config.cookieName}=${me.token};`)),
    ).toBe(true);
    expect(await userOf(w, me.user.id)).not.toBeNull();
  });

  it("serves api.user.delete on the engine call", async () => {
    const { createAuth } = await import("../src/create-auth.js");
    const w = world();
    const me = await verifiedSession(w.auth);
    const api = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: w.auth.storage,
      clock: w.auth.clock,
      mail: { send: async () => {} },
    }).api;
    expect(await api.user.delete({ session: me, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await userOf(w, me.user.id)).toBeNull();
  });
});

describe("the hold of the user row at a sign-in (plan 12a Task 11)", () => {
  it("reads the row again after a parallel write, and the sign-in passes with the write kept", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    beforeUserWrite(w, () =>
      w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
        name: "Parallel",
        updatedAt: new Date(w.auth.clock.now().getTime() + 5),
      }),
    );
    const r = await verifyMagicLink(w.auth.config, { token, ip: null, userAgent: null });
    expect(r.ok).toBe(true);
    expect((await userOf(w, me.user.id))?.name).toBe("Parallel");
  });

  it("answers conflict after 5 lost rounds, writes no session, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const before = (await childRows(w, "session", me.user.id)).length;
    let n = 0;
    beforeUserWrite(
      w,
      () =>
        w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
          name: `Parallel ${n++}`,
          updatedAt: new Date(w.auth.clock.now().getTime() + n),
        }),
      5,
    );
    expect(await verifyMagicLink(w.auth.config, { token, ip: null, userAgent: null })).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    expect(n).toBe(5);
    expect(log.mock.calls).toEqual([["authtempo: user hold gave up", me.user.id]]);
    expect(await childRows(w, "session", me.user.id)).toHaveLength(before);
  });
});

/** The token of the newest invitation mail. */
function invitationToken(w: World): string {
  const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(
    [...w.auth.mail].reverse().find((x) => /invitation=/.test(x.text))?.text ?? "",
  );
  if (!m?.[1]) throw new Error("no invitation mail");
  return m[1];
}

/**
 * A writer's config whose next transaction runs the delete of `proof` on a
 * D1-like view, inside the writer's open transaction, just before its first
 * `op` of `model`. D1 has no lock, so only the writer's read after its insert
 * can see that the user is gone. Both run on D1-like views: the memory undo
 * puts back a whole row, which D1 never does.
 */
function deleteBefore(w: World, proof: ResolvedSession, op: "create" | "update", model: string) {
  const d1 = d1Like(w.auth.config);
  const raw = d1.storage;
  const state: { deleted: Awaited<ReturnType<typeof deleteAccount>> | null } = { deleted: null };
  const run = async (m: string, o: "create" | "update") => {
    if (o === op && m === model && state.deleted === null)
      state.deleted = await deleteAccount(d1, input(proof));
  };
  const storage: StorageAdapter = {
    ...raw,
    transaction: (fn) =>
      raw.transaction((tx) =>
        fn({
          ...tx,
          create: async (m, data) => {
            await run(m, "create");
            return tx.create(m, data);
          },
          update: async (m, where, data) => {
            await run(m, "update");
            return tx.update(m, where, data);
          },
        }),
      ),
  };
  return { config: { ...d1, storage }, state };
}

const CONFLICT = { ok: false, code: "conflict", status: 409 };
const DELETED = { ok: true, value: { ok: true } };

describe("the writers of a row that names a user, beside the delete on D1 (review m2)", () => {
  it("an organization create that inserts after the delete is undone by its read of the user", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const d = deleteBefore(w, await live(w, me.token), "create", "organization");
    expect(
      await createOrganization(d.config, { user: me.user, slug: "ghost", name: "Ghost" }),
    ).toEqual(CONFLICT);
    expect(d.state.deleted).toEqual(DELETED);
    expect(await w.auth.storage.findMany("organization", [])).toEqual([]);
    expect(await childRows(w, "member", me.user.id)).toEqual([]);
  });

  it("a member add of the deleted user is undone by its read of the user", async () => {
    const w = world();
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const team = await organization(w, bob.user, "team");
    const me = await verifiedSession(w.auth);
    const d = deleteBefore(w, await live(w, me.token), "create", "member");
    expect(
      await addMember(d.config, {
        user: bob.user,
        organizationId: team.id,
        userId: me.user.id,
        role: "member",
      }),
    ).toEqual(CONFLICT);
    expect(d.state.deleted).toEqual(DELETED);
    expect((await membersOf(w, team.id)).map((m) => m.userId)).toEqual([bob.user.id]);
  });

  it("an accept by the deleted user is undone by its read of the user", async () => {
    const w = world();
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const club = await organization(w, bob.user, "club");
    const sent = await inviteMember(w.auth.config, {
      user: bob.user,
      organizationId: club.id,
      email: EMAIL,
      role: "member",
    });
    if (!sent.ok) throw new Error(sent.code);
    const me = await verifiedSession(w.auth);
    const d = deleteBefore(w, await live(w, me.token), "create", "member");
    expect(
      await acceptInvitation(d.config, { user: me.user, token: invitationToken(w), ip: null }),
    ).toEqual(CONFLICT);
    expect(d.state.deleted).toEqual(DELETED);
    expect((await membersOf(w, club.id)).map((m) => m.userId)).toEqual([bob.user.id]);
  });

  it("an accept into an organization that goes is undone by its read of the organization", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const solo = await organization(w, me.user, "ada-solo");
    const sent = await inviteMember(w.auth.config, {
      user: me.user,
      organizationId: solo.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!sent.ok) throw new Error(sent.code);
    const carol = await verifiedSession(w.auth, "carol@example.com");
    const token = invitationToken(w);
    const d = deleteBefore(w, await live(w, me.token), "create", "member");
    expect(await acceptInvitation(d.config, { user: carol.user, token, ip: null })).toEqual(
      CONFLICT,
    );
    expect(d.state.deleted).toEqual(DELETED);
    expect(await organizationOf(w, solo.id)).toBeNull();
    expect(await membersOf(w, solo.id)).toEqual([]);
  });

  it("a gated reset of the deleted user writes no password and no email identity", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const on = await enableEmailMethod(w.auth.config, { session: me, password: PASSWORD });
    if (!on.ok) throw new Error(on.code);
    expect((await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const d = deleteBefore(w, await live(w, me.token), "update", "password");
    expect(
      await resetPassword(d.config, {
        token,
        password: "a reset long password",
        ip: null,
        userAgent: null,
      }),
    ).toEqual(CONFLICT);
    expect(d.state.deleted).toEqual(DELETED);
    expect(await childRows(w, "password", me.user.id)).toEqual([]);
    expect(await childRows(w, "identity", me.user.id)).toEqual([]);
  });

  it("a first password of the deleted user is undone by its read of the user", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    expect(await childRows(w, "password", me.user.id)).toEqual([]);
    const d = deleteBefore(w, await live(w, me.token), "create", "password");
    expect(
      await changePassword(d.config, {
        session: await live(w, me.token),
        newPassword: "a first long password",
      }),
    ).toEqual(CONFLICT);
    expect(d.state.deleted).toEqual(DELETED);
    expect(await childRows(w, "password", me.user.id)).toEqual([]);
  });
});

describe("the delete's own order and rows (review L1 to L3)", () => {
  it("on D1 the organization row goes before its members, so an accept that inserts between is undone", async () => {
    // D1 has no lock. Carol's accept spends its invitation, then the delete
    // runs up to the member delete of the solo organization and pauses.
    // Then the accept inserts its member row and reads the organization,
    // which is gone already. Then the delete goes on.
    const w = world();
    const me = await verifiedSession(w.auth);
    const solo = await organization(w, me.user, "ada-solo");
    const sent = await inviteMember(w.auth.config, {
      user: me.user,
      organizationId: solo.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!sent.ok) throw new Error(sent.code);
    const carol = await verifiedSession(w.auth, "carol@example.com");
    const token = invitationToken(w);
    const proof = await live(w, me.token);
    const d1 = d1Like(w.auth.config);
    const raw = d1.storage;
    let paused: () => void = () => {};
    const atMembers = new Promise<void>((go) => {
      paused = go;
    });
    let resume: () => void = () => {};
    const goOn = new Promise<void>((go) => {
      resume = go;
    });
    const deleteView: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            delete: async (model, where) => {
              const n = await tx.delete(model, where);
              if (model === "member" && where[0]?.field === "organizationId") {
                paused();
                await goOn;
              }
              return n;
            },
          }),
        ),
    };
    let deleting: Promise<Awaited<ReturnType<typeof deleteAccount>>> | null = null;
    const acceptView: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (model === "member" && deleting === null) {
                deleting = deleteAccount({ ...d1, storage: deleteView }, input(proof));
                await atMembers;
              }
              return tx.create(model, data);
            },
          }),
        ),
    };
    const accepted = await acceptInvitation(
      { ...d1, storage: acceptView },
      { user: carol.user, token, ip: null },
    );
    resume();
    expect(await deleting).toEqual(DELETED);
    expect(accepted).toEqual(CONFLICT);
    expect(await organizationOf(w, solo.id)).toBeNull();
    expect(await membersOf(w, solo.id)).toEqual([]);
  });

  it("answers conflict when an owner write moves the organization between the rule's read and the owner lock", async () => {
    // D1 has no lock: Carol renames the team inside the delete's open
    // transaction. The owner lock then matches no row.
    const w = world();
    const me = await verifiedSession(w.auth);
    const team = await organization(w, me.user, "team");
    const carol = await verifiedSession(w.auth, "carol@example.com");
    await member(w, me.user, team.id, carol.user.id, "owner");
    const d1 = d1Like(w.auth.config);
    const raw = d1.storage;
    let renamed: Awaited<ReturnType<typeof updateOrganization>> | null = null;
    const view: StorageAdapter = {
      ...raw,
      transaction: (fn) =>
        raw.transaction((tx) =>
          fn({
            ...tx,
            update: async (model, where, data) => {
              if (model === "organization" && renamed === null) {
                w.auth.clock.advance(1);
                renamed = await updateOrganization(d1, {
                  user: carol.user,
                  organizationId: team.id,
                  name: "Renamed",
                });
              }
              return tx.update(model, where, data);
            },
          }),
        ),
    };
    expect(await deleteAccount({ ...d1, storage: view }, input(await live(w, me.token)))).toEqual(
      CONFLICT,
    );
    expect(renamed).toMatchObject({ ok: true });
    expect(await userOf(w, me.user.id)).not.toBeNull();
    expect((await membersOf(w, team.id)).length).toBe(2);
  });

  it("runs every before hook ahead of the first delete", async () => {
    const order: string[] = [];
    const w = world({
      hooks: {
        user: { beforeDelete: () => void order.push("user.beforeDelete") },
        organization: { beforeDelete: () => void order.push("organization.beforeDelete") },
      },
    });
    const me = await verifiedSession(w.auth);
    await organization(w, me.user, "ada-solo");
    const store = w.auth.config.storage as StorageAdapter;
    const original = store.transaction.bind(store);
    (store as { transaction: StorageAdapter["transaction"] }).transaction = ((fn) =>
      original((tx) =>
        fn({
          ...tx,
          delete: async (model, where) => {
            order.push(`delete:${model}`);
            return tx.delete(model, where);
          },
        }),
      )) as StorageAdapter["transaction"];
    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toEqual(DELETED);
    const first = order.findIndex((x) => x.startsWith("delete:"));
    expect(first).toBeGreaterThan(0);
    expect(order.slice(0, first)).toEqual(["organization.beforeDelete", "user.beforeDelete"]);
  });

  it("deletes the member rows of an earlier config with organizations off", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const team = await organization(w, me.user, "team");
    // The deployment turns organizations off after the rows were made.
    const off = { ...w.auth.config, organizations: null };
    expect(await deleteAccount(off, input(await live(w, me.token)))).toEqual(DELETED);
    expect(await membersOf(w, team.id)).toEqual([]);
    expect(await organizationOf(w, team.id)).not.toBeNull();
  });

  it("deletes the invitations of an organization that goes, also those of a former member", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const solo = await organization(w, me.user, "ada-solo");
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await member(w, me.user, solo.id, bob.user.id, "admin");
    const sent = await inviteMember(w.auth.config, {
      user: bob.user,
      organizationId: solo.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!sent.ok) throw new Error(sent.code);
    const gone = await removeMember(w.auth.config, {
      user: me.user,
      organizationId: solo.id,
      userId: bob.user.id,
    });
    expect(gone.ok).toBe(true);
    expect(await deleteAccount(w.auth.config, input(await live(w, me.token)))).toEqual(DELETED);
    expect(
      await w.auth.storage.findMany("invitation", [
        { field: "organizationId", op: "eq", value: solo.id },
      ]),
    ).toEqual([]);
  });
});
