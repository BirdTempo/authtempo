import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError } from "../src/errors.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { magicLink, passkey } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { COOKIE_NAME } from "../src/server/shapes.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";

// The gaps of the plan 12a audit, one block per task (Tasks 17 to 20).

const BASE = "https://api.example.com";
const PATH = `${BASE}/api/auth`;
const SECRET = "0123456789abcdef0123456789abcdef";
const DAY_MS = 86_400_000;

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

/** The session cookie a response sets, as `name=value`, or "". */
const sessionPair = (res: Response) =>
  (res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "").split(";")[0] ??
  "";

/** A shim on a memory database, with the magic link to sign in. `plugins` adds to the magic link. */
function instance(extra: Partial<BetterAuthOptions> = {}) {
  const links: string[] = [];
  const database = memoryDatabase();
  const { plugins = [], ...rest } = extra;
  const options: BetterAuthOptions = {
    baseURL: BASE,
    secret: SECRET,
    database,
    trustedOrigins: [BASE],
    plugins: [magicLink({ sendMagicLink: async ({ url }) => void links.push(url) }), ...plugins],
    ...rest,
  };
  const auth = betterAuth(options);
  /** A verified user and the cookie of its session, by the magic link. */
  async function signedIn(email: string) {
    await auth.api.signInMagicLink({ body: { email } });
    const token = new URL(links.at(-1) ?? "").searchParams.get("token") ?? "";
    const res = await auth.handler(
      new Request(`${PATH}/magic-link/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token }),
      }),
    );
    const cookie = sessionPair(res);
    if (!cookie) throw new Error(`the magic link answered ${res.status}`);
    return { cookie, token: cookie.slice(COOKIE_NAME.length + 1) };
  }
  const get = (path: string, cookie: string) =>
    auth.handler(new Request(`${PATH}${path}`, { headers: { cookie } }));
  const post = (path: string, cookie: string) =>
    auth.handler(
      new Request(`${PATH}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: "{}",
      }),
    );
  /** The expiry of the one session row, in ms. */
  async function expiry(): Promise<number> {
    const rows = await database.storage.findMany("session", []);
    if (rows.length !== 1 || !rows[0])
      throw new Error(`expected one session, found ${rows.length}`);
    return rows[0].expiresAt.getTime();
  }
  return { auth, signedIn, get, post, expiry };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Task 17 deferSessionRefresh", () => {
  it("maps deferSessionRefresh, and answers needsRefresh on GET /get-session", async () => {
    const options = { baseURL: BASE, secret: SECRET, database: memoryDatabase() };
    expect(
      mapOptions({ ...options, session: { deferSessionRefresh: true } }).config.session,
    ).toEqual({ ttlDays: 7, slidingRefreshDays: 1, freshMinutes: 1440, deferRefresh: true });
    expect(
      checkOptions({
        ...options,
        session: { deferSessionRefresh: "yes" as unknown as boolean },
      }).refusals,
    ).toEqual(["session.deferSessionRefresh: expected a boolean"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = instance({ session: { deferSessionRefresh: true } });
    const me = await s.signedIn("ada@example.com");
    const first = await s.get("/get-session", me.cookie);
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      needsRefresh: unknown;
      session: { token: string };
      user: { email: string };
    };
    expect(body.needsRefresh).toBe(false);
    expect(body.session.token).toBe(me.token);
    expect(body.user.email).toBe("ada@example.com");
    const before = await s.expiry();
    // Past Better Auth's default updateAge of one day.
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const due = await s.get("/get-session", me.cookie);
    expect(due.status).toBe(200);
    expect(due.headers.getSetCookie()).toEqual([]);
    expect(((await due.json()) as { needsRefresh: unknown }).needsRefresh).toBe(true);
    const viaApi = await s.auth.api.getSession({ headers: new Headers({ cookie: me.cookie }) });
    expect(viaApi?.needsRefresh).toBe(true);
    expect(await s.expiry()).toBe(before);
  });

  it("answers POST /get-session as Better Auth does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const on = instance({ session: { deferSessionRefresh: true } });
    const me = await on.signedIn("ada@example.com");
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const refreshed = await on.post("/get-session", me.cookie);
    expect(refreshed.status).toBe(200);
    expect(sessionPair(refreshed)).toBe(me.cookie);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["session", "user"]);
    expect(await on.expiry()).toBe(Date.now() + 7 * DAY_MS);
    const after = await on.get("/get-session", me.cookie);
    expect(((await after.json()) as { needsRefresh: unknown }).needsRefresh).toBe(false);
    // With no session, Better Auth answers null with 200.
    expect(await (await on.post("/get-session", "")).json()).toBeNull();

    const off = instance();
    const you = await off.signedIn("bob@example.com");
    const refused = await off.post("/get-session", you.cookie);
    expect(refused.status).toBe(405);
    expect(await refused.json()).toEqual({
      code: "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED",
      message: "POST method requires deferSessionRefresh to be enabled in session config",
    });
    // With the option off, a GET refreshes as before and answers no needsRefresh.
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    const read = await off.get("/get-session", you.cookie);
    expect(sessionPair(read)).toBe(you.cookie);
    expect(Object.keys((await read.json()) as object).sort()).toEqual(["session", "user"]);
    expect(await off.expiry()).toBe(Date.now() + 7 * DAY_MS);
    expect(await (await off.get("/get-session", "")).json()).toBeNull();
  });
});

describe("Task 18 email verification callbacks", () => {
  it("maps beforeEmailVerification and afterEmailVerification to the two points", async () => {
    const options = { baseURL: BASE, secret: SECRET, database: memoryDatabase() };
    expect(
      checkOptions({
        ...options,
        emailVerification: {
          beforeEmailVerification: "x" as never,
          afterEmailVerification: 1 as never,
        },
      }).refusals.sort(),
    ).toEqual([
      "emailVerification.afterEmailVerification: expected a function",
      "emailVerification.beforeEmailVerification: expected a function",
    ]);
    const calls: unknown[][] = [];
    const verifyLinks: string[] = [];
    const refuse = { on: false };
    const s = instance({
      emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
      emailVerification: {
        sendVerificationEmail: async ({ url }) => void verifyLinks.push(url),
        beforeEmailVerification: async (user, request) => {
          calls.push(["before", user.email, user.emailVerified, user.name, request]);
          if (refuse.on) throw new APIError("FORBIDDEN", { message: "Not yet." });
        },
        afterEmailVerification: async (user, request) => {
          calls.push(["after", user.email, user.emailVerified, user.name, request]);
        },
      },
      authtempo: {
        passwordHash: betterAuthPasswordHash({
          pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
        }),
      },
    });
    const signUp = (email: string) =>
      s.auth.api.signUpEmail({ body: { email, password: "correct horse battery", name: "" } });
    // Better Auth's user shape: an empty name for no name.
    // Better Auth's own place: the verify link. The GET page changes
    // nothing; its button posts the token. Core's hook carries no request.
    await signUp("ada@example.com");
    const link = new URL(verifyLinks.at(-1) ?? "");
    const verified = await s.auth.handler(
      new Request(`${link.origin}${link.pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token: link.searchParams.get("token") }),
      }),
    );
    expect(await verified.json()).toEqual({ verified: true });
    expect(calls).toEqual([
      ["before", "ada@example.com", false, "", undefined],
      ["after", "ada@example.com", true, "", undefined],
    ]);
    // Core calls them on each path that proves the address, the magic link too.
    calls.length = 0;
    await signUp("bob@example.com");
    await s.signedIn("bob@example.com");
    expect(calls).toEqual([
      ["before", "bob@example.com", false, "", undefined],
      ["after", "bob@example.com", true, "", undefined],
    ]);
    // A thrown APIError refuses with core's hook_refused, and no after call follows.
    calls.length = 0;
    refuse.on = true;
    await signUp("cy@example.com");
    await expect(s.signedIn("cy@example.com")).rejects.toThrow("the magic link answered 403");
    expect(calls).toEqual([["before", "cy@example.com", false, "", undefined]]);
  });

  it("calls the two callbacks at a change of address as Better Auth 1.7.2 does (review M2)", async () => {
    // Better Auth calls afterEmailVerification at the change link
    // (email-verification.mjs:229), and both at /email-otp/change-email
    // (routes.mjs:736 and :741).
    const { emailOTP } = await import("../src/plugins.js");
    const calls: unknown[][] = [];
    const links: string[] = [];
    const verifyMails: { token: string }[] = [];
    const codes: { otp: string }[] = [];
    const refuse = { on: false };
    const auth = betterAuth({
      baseURL: BASE,
      secret: SECRET,
      database: memoryDatabase(),
      trustedOrigins: [BASE],
      user: { changeEmail: { enabled: true } },
      emailVerification: {
        sendVerificationEmail: async ({ token }) => void verifyMails.push({ token }),
        beforeEmailVerification: async (user) => {
          calls.push(["before", user.email, user.emailVerified, user.name]);
          if (refuse.on) throw new APIError("FORBIDDEN", { message: "Not yet." });
        },
        afterEmailVerification: async (user) => {
          calls.push(["after", user.email, user.emailVerified, user.name]);
        },
      },
      plugins: [
        magicLink({ sendMagicLink: async ({ url }) => void links.push(url) }),
        emailOTP({
          sendVerificationOTP: async (d) => void codes.push(d),
          changeEmail: { enabled: true },
        }),
      ],
    });
    const post = (path: string, body: unknown, cookie = "") =>
      auth.handler(
        new Request(`${PATH}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: JSON.stringify(body),
        }),
      );
    await auth.api.signInMagicLink({ body: { email: "ada@example.com" } });
    const signIn = await post("/magic-link/verify", {
      token: new URL(links.at(-1) ?? "").searchParams.get("token"),
    });
    const cookie = sessionPair(signIn);
    // The change link: the after call only, with the moved user.
    await post("/change-email", { newEmail: "ada.link@example.com" }, cookie);
    const confirmed = await post("/user/change-email/confirm", {
      token: verifyMails.at(-1)?.token,
    });
    expect(confirmed.status).toBeLessThan(400);
    // Better Auth's user shape: an empty name for no name.
    expect(calls).toEqual([["after", "ada.link@example.com", true, ""]]);
    // The change by code: the before call with the user before the move, then the after call.
    calls.length = 0;
    const byCode = async (newEmail: string) => {
      await post("/email-otp/request-email-change", { newEmail }, cookie);
      return post("/email-otp/change-email", { newEmail, otp: codes.at(-1)?.otp }, cookie);
    };
    expect(await (await byCode("ada.code@example.com")).json()).toEqual({ success: true });
    expect(calls).toEqual([
      ["before", "ada.link@example.com", true, ""],
      ["after", "ada.code@example.com", true, ""],
    ]);
    // A thrown APIError in the before call refuses, and the address stays.
    calls.length = 0;
    refuse.on = true;
    const refused = await byCode("ada.no@example.com");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "HOOK_REFUSED", message: "Not yet." });
    expect(calls).toEqual([["before", "ada.code@example.com", true, ""]]);
    const me = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(me?.user.email).toBe("ada.code@example.com");
    // A profile update is not a change of address, so neither callback runs
    // (plan 12a fix wave, Task 18 review R2-L2: the via filter of the after map).
    calls.length = 0;
    refuse.on = false;
    const named = await post("/update-user", { name: "Ada" }, cookie);
    expect(named.status).toBe(200);
    const renamed = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(renamed?.user.name).toBe("Ada");
    expect(calls).toEqual([]);
  });
});

describe("Task 19 update-passkey", () => {
  it("maps POST /passkey/update-passkey onto the rename", async () => {
    const rp = { rpID: "api.example.com", rpName: "Example", origin: BASE };
    const s = instance({ plugins: [passkey(rp)] });
    const tempo = s.auth.tempo.api;
    /** A passkey by core's register ceremony, as the product makes one. */
    async function added(token: string) {
      const me = await tempo.getSession(token);
      if (!me) throw new Error("no session");
      const soft = await SoftAuthenticator.create({ rpID: rp.rpID, origin: BASE });
      const options = await tempo.passkeyRegistrationOptions({ session: me });
      if (!options.ok) throw new Error(options.code);
      const r = await tempo.verifyPasskeyRegistration({
        session: me,
        response: await soft.register(options.value.challenge),
        name: "Phone",
      });
      if (!r.ok) throw new Error(r.code);
      return { user: me.user, key: r.value };
    }
    const ada = await s.signedIn("ada@example.com");
    const bob = await s.signedIn("bob@example.com");
    const mine = await added(ada.token);
    const theirs = await added(bob.token);
    const update = (cookie: string, body: unknown) =>
      s.auth.handler(
        new Request(`${PATH}/passkey/update-passkey`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: JSON.stringify(body),
        }),
      );
    // Better Auth 1.7.2 trims the name and answers { passkey } (@better-auth/passkey dist/index.mjs:634, :665).
    const res = await update(ada.cookie, { id: mine.key.id, name: "  Work laptop " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      passkey: {
        id: mine.key.id,
        name: "Work laptop",
        userId: mine.user.id,
        credentialID: mine.key.credentialId,
        deviceType: mine.key.deviceType,
        backedUp: mine.key.backedUp,
        createdAt: mine.key.createdAt.toISOString(),
      },
    });
    // Another user's passkey answers as an unknown id: Better Auth's code, with no oracle.
    for (const id of [theirs.key.id, "pk_unknown"]) {
      const missing = await update(ada.cookie, { id, name: "Mine" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        code: "PASSKEY_NOT_FOUND",
        message: "Passkey not found",
      });
    }
    const rows = await s.auth.tempo.api.listPasskeys({ user: theirs.user });
    expect(rows.ok && rows.value.map((p) => p.name)).toEqual(["Phone"]);
    // A name that is empty after the trim, a missing name, or a name of another rule.
    for (const body of [
      { id: mine.key.id, name: "   " },
      { id: mine.key.id },
      { id: mine.key.id, name: "a\u202eb" },
    ]) {
      const refused = await update(ada.cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    const unauthorized = await update("", { id: mine.key.id, name: "Mine" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ code: "UNAUTHORIZED" });
    const list = await tempo.listPasskeys({ user: mine.user });
    expect(list.ok && list.value.map((p) => p.name)).toEqual(["Work laptop"]);
    // Without the passkey plugin, core's router answers the path 404.
    const off = instance();
    const you = await off.signedIn("cy@example.com");
    const none = await off.auth.handler(
      new Request(`${PATH}/passkey/update-passkey`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: you.cookie },
        body: JSON.stringify({ id: "pk_x", name: "Mine" }),
      }),
    );
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "not_found" });
  });
});

describe("Task 20 sendDeleteAccountVerification", () => {
  it("maps sendDeleteAccountVerification; GET /delete-user/callback serves the page and deletes nothing", async () => {
    const mails: { email: string; url: string; token: string; request: unknown }[] = [];
    const order: string[] = [];
    const s = instance({
      user: {
        deleteUser: {
          enabled: true,
          sendDeleteAccountVerification: async ({ user, url, token }, request) =>
            void mails.push({ email: user.email, url, token, request }),
          beforeDelete: async (u) => void order.push(`before:${u.email}`),
          afterDelete: async (u) => void order.push(`after:${u.email}`),
        },
      },
    });
    // Better Auth's default life of the link, 24 hours, and a set one in minutes.
    const at = (deleteUser: NonNullable<NonNullable<BetterAuthOptions["user"]>["deleteUser"]>) =>
      mapOptions({
        baseURL: BASE,
        secret: SECRET,
        database: memoryDatabase(),
        user: { deleteUser },
      });
    const send = async () => {};
    expect(
      at({ enabled: true, sendDeleteAccountVerification: send }).config.account?.deleteConfirm,
    ).toEqual({
      ttlMinutes: 1440,
    });
    expect(
      at({ enabled: true, sendDeleteAccountVerification: send, deleteTokenExpiresIn: 600 }).config
        .account?.deleteConfirm,
    ).toEqual({ ttlMinutes: 10 });
    expect(at({ enabled: true }).config.account?.deleteConfirm).toBeUndefined();
    const a = await s.signedIn("ada@example.com");
    const post = (path: string, body: unknown, cookie: string) =>
      s.auth.handler(
        new Request(`${PATH}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: JSON.stringify(body),
        }),
      );
    const asked = await post("/delete-user", {}, a.cookie);
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ success: true, message: "Verification email sent" });
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    expect(mail?.email).toBe("ada@example.com");
    expect(mail?.request).toBeUndefined();
    expect(mail?.token).toMatch(/^ad_[A-Za-z0-9_-]{43}$/);
    expect(mail?.url).toBe(`${PATH}/user/delete/confirm?token=${mail?.token}`);
    expect(order).toEqual([]);
    // A mail scanner fetches Better Auth's callback path: the page, no delete.
    for (let i = 0; i < 2; i++) {
      const page = await s.auth.handler(
        new Request(`${PATH}/delete-user/callback?token=${mail?.token}&callbackURL=/bye`, {
          headers: { cookie: a.cookie },
        }),
      );
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain(`value="${mail?.token}"`);
      expect(html).toContain('action="/api/auth/user/delete/confirm"');
    }
    expect(order).toEqual([]);
    expect(
      await s.auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) }),
    ).not.toBeNull();
    // Another user's session cannot spend the link.
    const b = await s.signedIn("bo@example.com");
    const foreign = await post("/delete-user", { token: mail?.token }, b.cookie);
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ code: "INVALID_TOKEN" });
    // Better Auth's POST /delete-user { token } is the confirm.
    const done = await post("/delete-user", { token: mail?.token }, a.cookie);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ success: true, message: "User deleted" });
    expect(done.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=;`))).toBe(true);
    expect(order).toEqual(["before:ada@example.com", "after:ada@example.com"]);
    expect(await s.auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) })).toBeNull();
    // auth.api: the request mails, and the token confirms.
    const headers = new Headers({ cookie: b.cookie });
    expect(await s.auth.api.deleteUser({ body: {}, headers })).toEqual({
      success: true,
      message: "Verification email sent",
    });
    expect(
      await s.auth.api.deleteUser({ body: { token: mails.at(-1)?.token ?? "" }, headers }),
    ).toEqual({ success: true, message: "User deleted" });
    expect(await s.auth.api.getSession({ headers })).toBeNull();
  });

  it("confirms the token from a stale session on both surfaces, as Better Auth spends it before its fresh check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tokens: string[] = [];
    const s = instance({
      session: { freshAge: 60 },
      user: {
        deleteUser: {
          enabled: true,
          sendDeleteAccountVerification: async ({ token }) => void tokens.push(token),
        },
      },
    });
    const request = (cookie: string) =>
      s.auth.handler(
        new Request(`${PATH}/delete-user`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: JSON.stringify({}),
        }),
      );
    const a = await s.signedIn("ada@example.com");
    const b = await s.signedIn("bo@example.com");
    for (const x of [a, b]) expect((await request(x.cookie)).status).toBe(200);
    const [aToken, bToken] = tokens;
    // Past freshAge: the request itself would answer SESSION_NOT_FRESH now.
    vi.setSystemTime(Date.now() + 120_000);
    const staleRequest = await request(a.cookie);
    expect(staleRequest.status).toBe(403);
    expect(await staleRequest.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });
    // The handler: Better Auth 1.7.2 spends the token before its fresh check (update-user.mjs:307 to :335).
    const byHandler = await s.auth.handler(
      new Request(`${PATH}/delete-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: a.cookie },
        body: JSON.stringify({ token: aToken }),
      }),
    );
    expect(byHandler.status).toBe(200);
    expect(await byHandler.json()).toEqual({ success: true, message: "User deleted" });
    // auth.api.
    const headers = new Headers({ cookie: b.cookie });
    expect(await s.auth.api.deleteUser({ body: { token: bToken ?? "" }, headers })).toEqual({
      success: true,
      message: "User deleted",
    });
    for (const x of [a, b])
      expect(
        await s.auth.api.getSession({ headers: new Headers({ cookie: x.cookie }) }),
      ).toBeNull();
  });

  it("refuses a deleteTokenExpiresIn that is not a whole number of minutes from 300 to 86400 seconds", () => {
    const refusalsOf = (deleteTokenExpiresIn: unknown, send: unknown = async () => {}) =>
      checkOptions({
        baseURL: BASE,
        secret: SECRET,
        database: memoryDatabase(),
        user: {
          deleteUser: { enabled: true, sendDeleteAccountVerification: send, deleteTokenExpiresIn },
        },
      } as unknown as BetterAuthOptions).refusals.filter((r) => r.startsWith("user.deleteUser"));
    for (const v of [240, 299, 330, 86_460, "600", 600.5])
      expect(refusalsOf(v), String(v)).toEqual([
        "user.deleteUser.deleteTokenExpiresIn: core takes a whole number of minutes from 300 to 86400 seconds",
      ]);
    for (const v of [300, 3600, 86_400, undefined]) expect(refusalsOf(v), String(v)).toEqual([]);
    expect(refusalsOf(undefined, "a url")).toEqual([
      "user.deleteUser.sendDeleteAccountVerification: expected a function",
    ]);
  });
});
