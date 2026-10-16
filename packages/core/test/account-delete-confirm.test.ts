import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import {
  confirmAccountDelete,
  DELETE_PER_USER,
  requestAccountDelete,
  startAccountDelete,
} from "../src/engine/account-delete.js";
import type { AccountMailInput } from "../src/engine/account-mail.js";
import {
  CONFIRM_PER_IP,
  confirmEmailChange,
  requestEmailChange,
} from "../src/engine/email-change.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { addMember, createOrganization, removeMember } from "../src/engine/organizations.js";
import { type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { defaultAccountDeletePage } from "../src/http/account-delete-page.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow, VerificationRow } from "../src/schema.js";
import { d1Like } from "./d1-like.js";
import { BASE_URL, get, makeAuth, post } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";
import { type Auth, EMAIL, totpAuth, verifiedSession } from "./totp-helpers.js";

const MINUTE = 60_000;
const NOTICE = "Security notice for your api.example.com account";
const SUBJECT = "Confirm the delete of your api.example.com account";
const CONFIRM_PATH = "/auth/user/delete/confirm";

afterEach(() => {
  vi.restoreAllMocks();
});

/** An auth with the mailed confirm on, its router, and a cookie header for a token. */
function world(extra: Partial<AuthConfig> = {}) {
  const auth = totpAuth({
    ...extra,
    account: { deleteConfirm: { ttlMinutes: 60 }, ...extra.account },
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, handle, cookie };
}
type World = ReturnType<typeof world>;

/** The token of the newest delete link to `to`. */
function linkOf(auth: Auth, to = EMAIL): string {
  const m = [...auth.mail].reverse().find((x) => x.to === to && x.subject === SUBJECT);
  const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
  if (!token) throw new Error(`no delete link to ${to}`);
  return decodeURIComponent(token);
}

const input = (session: ResolvedSession, ip: string | null = "3.3.3.3") => ({
  session,
  ip,
  userAgent: "ua",
});

async function userOf(auth: Auth, id: string): Promise<UserRow | null> {
  return auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);
}

async function deleteRows(auth: Auth): Promise<VerificationRow[]> {
  return auth.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "account-delete" },
  ]);
}

const notices = (auth: Auth) => auth.mail.filter((m) => m.subject === NOTICE);

/** A form post of the confirm page, with the session cookie, as a browser sends it. */
function formPost(w: World, token: string, sessionToken: string | null): Request {
  return new Request(`${BASE_URL}${CONFIRM_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      ...(sessionToken ? w.cookie(sessionToken) : {}),
    },
    body: new URLSearchParams({ token }).toString(),
  });
}

const cleared = (res: Response, name: string) =>
  res.headers.getSetCookie().some((c) => c.startsWith(`${name}=;`));

describe("the mailed confirm of an account delete (plan 12a Task 20)", () => {
  it("refuses a ttlMinutes out of 5 to 1440 at construction", () => {
    const build = (deleteConfirm: unknown) =>
      makeAuth({ account: { deleteConfirm: deleteConfirm as false } }).config.account.deleteConfirm;
    for (const ttlMinutes of [4, 1441, 4.5, "60"]) {
      expect(() => build({ ttlMinutes }), String(ttlMinutes)).toThrow(ConfigError);
      expect(() => build({ ttlMinutes }), String(ttlMinutes)).toThrow(
        "account.deleteConfirm.ttlMinutes must be an integer from 5 to 1440",
      );
    }
    expect(() => build(true)).toThrow("account.deleteConfirm must be an object or false");
    expect(() => build({ ttl: 5 })).toThrow(
      "account.deleteConfirm.ttl is not an option; core has ttlMinutes",
    );
    expect(build({ ttlMinutes: 5 })).toEqual({ ttlMinutes: 5 });
    expect(build({ ttlMinutes: 1440 })).toEqual({ ttlMinutes: 1440 });
    expect(build({})).toEqual({ ttlMinutes: 60 });
    expect(build(false)).toBeNull();
    expect(build(undefined)).toBeNull();
  });

  it("deletes nothing at the request, mails one link, and answers { sent: true }", async () => {
    const calls: string[] = [];
    const w = world({
      hooks: { user: { beforeDelete: () => void calls.push("before") } },
    });
    const me = await verifiedSession(w.auth);
    const mailsBefore = w.auth.mail.length;
    const res = await w.handle(post("/auth/user/delete", {}, w.cookie(me.token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    // The session stays: no cookie is cleared.
    expect(cleared(res, w.auth.config.cookieName)).toBe(false);
    expect(await resolveSession(w.auth.config, me.token)).not.toBeNull();
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
    expect(calls).toEqual([]);
    const mails = w.auth.mail.slice(mailsBefore);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(EMAIL);
    expect(mails[0]?.subject).toBe(SUBJECT);
    expect(mails[0]?.text).toContain(`${BASE_URL}/auth/user/delete/confirm?token=ad_`);
    expect(mails[0]?.text).toContain("It is valid for 60 minutes.");
    const token = linkOf(w.auth);
    const rows = await deleteRows(w.auth);
    expect(rows).toHaveLength(1);
    const now = w.auth.clock.now().getTime();
    expect(rows[0]).toMatchObject({
      identifier: me.user.id,
      valueHash: await sha256Hex(token),
      consumedAt: null,
      data: null,
    });
    expect(rows[0]?.expiresAt.getTime()).toBe(now + 60 * MINUTE);
    expect(notices(w.auth)).toEqual([]);
  });

  it("reads nothing and spends nothing at the GET of the link", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    expect((await requestAccountDelete(w.auth.config, input(me))).ok).toBe(true);
    const token = linkOf(w.auth);
    const reads = vi.spyOn(w.auth.config.storage, "findOne");
    const many = vi.spyOn(w.auth.config.storage, "findMany");
    const writes = vi.spyOn(w.auth.config.storage, "update");
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    for (let i = 0; i < 2; i++) {
      const page = await w.handle(get(`${CONFIRM_PATH}?token=${token}`, w.cookie(me.token)));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(page.headers.get("content-security-policy")).not.toContain("script-src");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("set-cookie")).toBeNull();
      const html = await page.text();
      expect(html).toContain(`value="${token}"`);
      expect(html).toContain(`action="${CONFIRM_PATH}"`);
      expect(html).toContain('method="post"');
      expect(html).not.toContain("<script");
    }
    expect(reads).not.toHaveBeenCalled();
    expect(many).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(allow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect((await deleteRows(w.auth))[0]?.consumedAt).toBeNull();
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
    // A malformed token lands on the error page of the app.
    const bad = await w.handle(get(`${CONFIRM_PATH}?token=ad_short`));
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
  });

  it("deletes the account at the POST of the link with the user's session", async () => {
    const calls: string[] = [];
    const w = world({
      hooks: {
        user: {
          beforeDelete: ({ user }) => void calls.push(`before:${user.email}`),
          afterDelete: ({ user }) => void calls.push(`after:${user.email}`),
        },
      },
    });
    const other = await verifiedSession(w.auth, EMAIL, "1.1.1.1");
    const me = await verifiedSession(w.auth, EMAIL, "2.2.2.2");
    expect(await requestAccountDelete(w.auth.config, input(me))).toEqual({
      ok: true,
      value: { sent: true },
    });
    const token = linkOf(w.auth);
    expect(calls).toEqual([]);
    const res = await w.handle(formPost(w, token, me.token));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/`);
    expect(cleared(res, w.auth.config.cookieName)).toBe(true);
    expect(await userOf(w.auth, me.user.id)).toBeNull();
    for (const s of [me, other]) expect(await resolveSession(w.auth.config, s.token)).toBeNull();
    expect(
      await w.auth.storage.findMany("session", [{ field: "userId", op: "eq", value: me.user.id }]),
    ).toEqual([]);
    expect(await deleteRows(w.auth)).toEqual([]);
    expect(calls).toEqual([`before:${EMAIL}`, `after:${EMAIL}`]);
    // The notice of Task 6, after the commit, to the address the delete held.
    const sent = notices(w.auth);
    expect(sent.map((m) => m.to)).toEqual([EMAIL]);
    expect(sent[0]?.text).toContain("Your account was deleted.");
  });

  it("answers JSON at the POST with the user's session, and clears the cookie", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    const res = await w.handle(
      post("/auth/user/delete/confirm", { token: linkOf(w.auth) }, w.cookie(me.token)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cleared(res, w.auth.config.cookieName)).toBe(true);
    expect(await userOf(w.auth, me.user.id)).toBeNull();
  });

  it("answers invalid_token to a second POST of the same link", async () => {
    // On D1 two confirms interleave with no lock. The second runs inside the
    // first's transaction, after the first's spend: only the spend's
    // `consumedAt` term stops it.
    let inner: Promise<unknown> | null = null;
    let d1: ReturnType<typeof d1Like> | null = null;
    let second: ResolvedSession | null = null;
    let token = "";
    const w = world({
      hooks: {
        user: {
          beforeDelete: async () => {
            if (inner || !d1 || !second) return;
            inner = confirmAccountDelete(d1, { ...input(second), token });
            await inner;
          },
        },
      },
    });
    const me = await verifiedSession(w.auth, EMAIL, "1.1.1.1");
    second = await verifiedSession(w.auth, EMAIL, "2.2.2.2");
    d1 = d1Like(w.auth.config);
    await requestAccountDelete(w.auth.config, input(me));
    token = linkOf(w.auth);
    expect(await confirmAccountDelete(d1, { ...input(me), token })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await inner).toEqual({ ok: false, code: "invalid_token", status: 400 });
    expect(await userOf(w.auth, me.user.id)).toBeNull();
    expect(notices(w.auth)).toHaveLength(1);
    // On one store after the commit: the session is gone with the account.
    const again = await w.handle(post("/auth/user/delete/confirm", { token }, w.cookie(me.token)));
    expect(again.status).toBe(401);
  });

  it("answers invalid_token with another user's session, and after the ttl", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await requestAccountDelete(w.auth.config, input(me));
    const token = linkOf(w.auth);
    const byBob = await w.handle(post("/auth/user/delete/confirm", { token }, w.cookie(bob.token)));
    expect(byBob.status).toBe(400);
    expect(await byBob.json()).toEqual({ error: "invalid_token" });
    expect(cleared(byBob, w.auth.config.cookieName)).toBe(false);
    for (const u of [me, bob]) expect(await userOf(w.auth, u.user.id)).not.toBeNull();
    expect((await deleteRows(w.auth))[0]?.consumedAt).toBeNull();
    // The end of the window: at expiresAt the link is dead.
    w.auth.clock.advance(60 * MINUTE);
    expect(await confirmAccountDelete(w.auth.config, { ...input(me), token })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
    w.auth.clock.advance(MINUTE);
    const late = await w.handle(formPost(w, token, me.token));
    expect(late.status).toBe(302);
    expect(late.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
  });

  it("deletes 1 ms before the end of the ttl, with a session that is no longer fresh", async () => {
    const w = world({ session: { freshMinutes: 5 } });
    const me = await verifiedSession(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    w.auth.clock.advance(60 * MINUTE - 1);
    const stale = await resolveSession(w.auth.config, me.token);
    if (!stale) throw new Error("no session");
    expect(
      await confirmAccountDelete(w.auth.config, { ...input(stale), token: linkOf(w.auth) }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await userOf(w.auth, me.user.id)).toBeNull();
  });

  it("ends the older link at a new request", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    const first = linkOf(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    const second = linkOf(w.auth);
    expect(second).not.toBe(first);
    expect(await deleteRows(w.auth)).toHaveLength(1);
    expect(await confirmAccountDelete(w.auth.config, { ...input(me), token: first })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
    expect(await confirmAccountDelete(w.auth.config, { ...input(me), token: second })).toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("deletes at once as in Task 11 with the key off", async () => {
    const auth = totpAuth();
    expect(auth.config.account.deleteConfirm).toBeNull();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const me = await verifiedSession(auth);
    const mailsBefore = auth.mail.length;
    const res = await handle(
      post("/auth/user/delete", {}, { cookie: `${auth.config.cookieName}=${me.token}` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cleared(res, auth.config.cookieName)).toBe(true);
    expect(await userOf(auth, me.user.id)).toBeNull();
    expect(auth.mail.slice(mailsBefore).map((m) => m.subject)).toEqual([NOTICE]);
    // The engine's request answers not_found with the key off.
    const bob = await verifiedSession(auth, "bob@example.com");
    expect(await requestAccountDelete(auth.config, input(bob))).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("answers sole_owner at the request and again at the confirm, and the link stays live", async () => {
    const w = world({ organizations: {} });
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const team = await createOrganization(w.auth.config, {
      user: me.user,
      slug: "team",
      name: "Team",
    });
    if (!team.ok) throw new Error(team.code);
    const organizationId = team.value.organization.id;
    const add = () =>
      addMember(w.auth.config, {
        user: me.user,
        organizationId,
        userId: bob.user.id,
        role: "admin",
      });
    expect((await add()).ok).toBe(true);
    const mailsBefore = w.auth.mail.length;
    expect(await requestAccountDelete(w.auth.config, input(me))).toEqual({
      ok: false,
      code: "sole_owner",
      status: 409,
    });
    expect(w.auth.mail.length).toBe(mailsBefore);
    expect(await deleteRows(w.auth)).toEqual([]);
    // Bob leaves; the request mails a link; Bob joins again before the confirm.
    expect(
      (await removeMember(w.auth.config, { user: me.user, organizationId, userId: bob.user.id }))
        .ok,
    ).toBe(true);
    expect((await requestAccountDelete(w.auth.config, input(me))).ok).toBe(true);
    const token = linkOf(w.auth);
    expect((await add()).ok).toBe(true);
    expect(await confirmAccountDelete(w.auth.config, { ...input(me), token })).toEqual({
      ok: false,
      code: "sole_owner",
      status: 409,
    });
    // The refusal undid the spend with the lock.
    expect((await deleteRows(w.auth))[0]?.consumedAt).toBeNull();
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
    expect(
      (await removeMember(w.auth.config, { user: me.user, organizationId, userId: bob.user.id }))
        .ok,
    ).toBe(true);
    expect((await confirmAccountDelete(w.auth.config, { ...input(me), token })).ok).toBe(true);
    expect(await userOf(w.auth, me.user.id)).toBeNull();
  });

  it("keeps the link live after a refusal of user.beforeDelete", async () => {
    let refuse = true;
    const w = world({
      hooks: {
        user: {
          beforeDelete: () => {
            if (refuse) throw hookRefusal("keep it");
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    const token = linkOf(w.auth);
    expect(await confirmAccountDelete(w.auth.config, { ...input(me), token })).toMatchObject({
      ok: false,
      code: "hook_refused",
    });
    expect((await deleteRows(w.auth))[0]?.consumedAt).toBeNull();
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
    expect(notices(w.auth)).toEqual([]);
    refuse = false;
    expect((await confirmAccountDelete(w.auth.config, { ...input(me), token })).ok).toBe(true);
  });

  it("keeps the checks of the direct delete at the request, in their order", async () => {
    const w = world({ session: { freshMinutes: 5 } });
    const me = await verifiedSession(w.auth);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    w.auth.clock.advance(6 * MINUTE);
    const stale = await resolveSession(w.auth.config, me.token);
    if (!stale) throw new Error("no session");
    expect(await startAccountDelete(w.auth.config, input(stale))).toMatchObject({
      ok: false,
      code: "session_not_fresh",
    });
    expect(allow).not.toHaveBeenCalled();
    expect(await deleteRows(w.auth)).toEqual([]);
    // A fresh session: the per-user limit of Task 11, 5 per hour.
    const fresh = await verifiedSession(w.auth);
    for (let i = 0; i < DELETE_PER_USER.max; i++)
      expect((await startAccountDelete(w.auth.config, input(fresh))).ok).toBe(true);
    expect(await startAccountDelete(w.auth.config, input(fresh))).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    expect(allow).toHaveBeenLastCalledWith(`user-delete:user:${me.user.id}`, {
      seconds: 3600,
      max: 5,
    });
    // account.delete false: no route, and the engine answers not_found with no count.
    const off = world({ account: { delete: false, deleteConfirm: {} } });
    const bob = await verifiedSession(off.auth, "bob@example.com");
    const offAllow = vi.spyOn(off.auth.config.limiter, "allow");
    expect(await startAccountDelete(off.auth.config, input(bob))).toMatchObject({
      code: "not_found",
    });
    expect(
      await confirmAccountDelete(off.auth.config, { ...input(bob), token: `ad_${"a".repeat(43)}` }),
    ).toMatchObject({ code: "not_found" });
    expect(offAllow).not.toHaveBeenCalled();
    for (const path of ["/auth/user/delete", CONFIRM_PATH])
      expect((await off.handle(post(path, {}, off.cookie(bob.token)))).status, path).toBe(404);
    expect((await off.handle(get(`${CONFIRM_PATH}?token=ad_${"a".repeat(43)}`))).status).toBe(404);
  });

  it("counts the confirms per IP: 20 per 15 minutes, after the format check", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(
      await confirmAccountDelete(w.auth.config, { ...input(me, "::ffff:5.5.5.5"), token: "ad_x" }),
    ).toMatchObject({ code: "invalid_token" });
    expect(allow).not.toHaveBeenCalled();
    const wrong = `ad_${"b".repeat(43)}`;
    for (let i = 0; i < CONFIRM_PER_IP.max; i++)
      expect(
        await confirmAccountDelete(w.auth.config, { ...input(me, "5.5.5.5"), token: wrong }),
      ).toMatchObject({ code: "invalid_token" });
    expect(
      await confirmAccountDelete(w.auth.config, { ...input(me, "::ffff:5.5.5.5"), token: wrong }),
    ).toMatchObject({ code: "rate_limited" });
    expect(allow).toHaveBeenLastCalledWith("user-delete-confirm:ip:5.5.5.5", {
      seconds: 900,
      max: 20,
    });
    // Another IP has its own count.
    expect(
      await confirmAccountDelete(w.auth.config, { ...input(me, "6.6.6.6"), token: wrong }),
    ).toMatchObject({ code: "invalid_token" });
  });

  it("needs a session at the confirm", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    const token = linkOf(w.auth);
    const json = await w.handle(post("/auth/user/delete/confirm", { token }));
    expect(json.status).toBe(401);
    const form = await w.handle(formPost(w, token, null));
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toBe(`${BASE_URL}/?auth_error=unauthorized`);
    const noToken = await w.handle(
      post("/auth/user/delete/confirm", { nothing: 1 }, w.cookie(me.token)),
    );
    expect(noToken.status).toBe(400);
    expect(await noToken.json()).toEqual({ error: "invalid_token" });
    expect((await deleteRows(w.auth))[0]?.consumedAt).toBeNull();
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
  });

  it("ends a pending delete link at a change of address, and only the mover's", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await requestAccountDelete(w.auth.config, input(bob));
    const bobToken = linkOf(w.auth, "bob@example.com");
    await requestAccountDelete(w.auth.config, input(me));
    const token = linkOf(w.auth);
    await requestEmailChange(w.auth.config, { session: me, newEmail: "ada.new@example.com" });
    const change = /token=([A-Za-z0-9_%-]+)/.exec(w.auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
    expect(
      (await confirmEmailChange(w.auth.config, { token: change, ip: null, userAgent: null })).ok,
    ).toBe(true);
    // The move deletes the mover's link only (review m1).
    expect((await deleteRows(w.auth)).map((r) => r.identifier)).toEqual([bob.user.id]);
    const moved = await resolveSession(w.auth.config, me.token);
    if (!moved) throw new Error("no session");
    expect(await confirmAccountDelete(w.auth.config, { ...input(moved), token })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
    expect(await userOf(w.auth, me.user.id)).not.toBeNull();
    expect(await confirmAccountDelete(w.auth.config, { ...input(bob), token: bobToken })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await userOf(w.auth, bob.user.id)).toBeNull();
  });

  it("mails through account.mail with the kind delete_confirm, to the user's address", async () => {
    const seen: AccountMailInput[] = [];
    const w = world({
      account: {
        deleteConfirm: { ttlMinutes: 15 },
        mail: (i) => {
          seen.push(i);
          return { to: "elsewhere@example.com", subject: "custom", text: "custom" };
        },
      },
    });
    const me = await verifiedSession(w.auth);
    await requestAccountDelete(w.auth.config, input(me));
    expect(seen).toHaveLength(1);
    const [mail] = seen;
    expect(mail).toMatchObject({
      kind: "delete_confirm",
      email: EMAIL,
      ttlMinutes: 15,
      appName: "api.example.com",
    });
    expect(mail && "link" in mail ? mail.link : "").toMatch(
      /^https:\/\/api\.example\.com\/auth\/user\/delete\/confirm\?token=ad_[A-Za-z0-9_-]{43}$/,
    );
    expect(w.auth.mail.at(-1)?.to).toBe(EMAIL);
    const row = (await deleteRows(w.auth))[0];
    expect(row?.expiresAt.getTime()).toBe(w.auth.clock.now().getTime() + 15 * MINUTE);
  });

  it("answers { sent: true } from api.user.delete with the key on, and api.user.confirmDelete deletes", async () => {
    const h = pwHandle({ hash: FAST }, { account: { deleteConfirm: { ttlMinutes: 60 } } });
    await h.auth.api.requestMagicLink({ email: EMAIL, ip: null });
    const signIn = await h.auth.api.verifyMagicLink({
      token: h.mails.at(-1)?.token ?? "",
      ip: null,
      userAgent: null,
    });
    if (!signIn.ok || !("token" in signIn.value)) throw new Error("no session");
    const me = await h.auth.api.getSession(signIn.value.token);
    if (!me) throw new Error("no session");
    expect(await h.auth.api.user.delete(input(me))).toEqual({ ok: true, value: { sent: true } });
    const token = h.mails.at(-1)?.token ?? "";
    expect(token.startsWith("ad_")).toBe(true);
    expect(await h.auth.api.user.confirmDelete({ ...input(me), token: `${token}x` })).toMatchObject(
      { code: "invalid_token" },
    );
    expect(await h.auth.api.user.confirmDelete({ ...input(me), token })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(
      await h.storage.findOne("user", [{ field: "id", op: "eq", value: me.user.id }]),
    ).toBeNull();
    // With the key off, api.user.delete deletes at once, as in Task 11.
    const off = pwHandle({ hash: FAST });
    await off.auth.api.requestMagicLink({ email: EMAIL, ip: null });
    const offIn = await off.auth.api.verifyMagicLink({
      token: off.mails.at(-1)?.token ?? "",
      ip: null,
      userAgent: null,
    });
    if (!offIn.ok || !("token" in offIn.value)) throw new Error("no session");
    const bob = await off.auth.api.getSession(offIn.value.token);
    if (!bob) throw new Error("no session");
    expect(await off.auth.api.user.delete(input(bob))).toEqual({ ok: true, value: { ok: true } });
  });

  it("escapes the app name and the token in the page", () => {
    const html = defaultAccountDeletePage({
      action: '/a"b',
      token: 'ad_<x>"',
      appName: "<b>App</b>",
    });
    expect(html).toContain("&lt;b&gt;App&lt;/b&gt;");
    expect(html).not.toContain("<b>App</b>");
    expect(html).toContain('value="ad_&lt;x&gt;&quot;"');
    expect(html).toContain('action="/a&quot;b"');
  });
});
