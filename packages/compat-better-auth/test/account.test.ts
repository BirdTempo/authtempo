import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import type { Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BETTER_AUTH_CODES } from "../src/errors.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { emailOTP, magicLink, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { compatAccountMail } from "../src/server/mail.js";
import { mapOptions } from "../src/server/map-options.js";
import { COOKIE_NAME } from "../src/server/shapes.js";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { issuerFor } from "../src/storage/mapping.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

const BASE = "https://api.example.com";
const PATH = `${BASE}/api/auth`;
const SECRET = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

const sessionPair = (res: Response) =>
  (res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "").split(";")[0] ??
  "";

/** `more` are plugins after the magic link, which every test signs in with. */
function instance(
  extra: Partial<BetterAuthOptions> = {},
  more: NonNullable<BetterAuthOptions["plugins"]> = [],
  database: CompatDatabase = memoryDatabase(),
) {
  const links: string[] = [];
  const verifyMails: { email: string; url: string; token: string }[] = [];
  const auth = betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database,
    trustedOrigins: [BASE],
    emailVerification: {
      sendVerificationEmail: async ({ user, url, token }) =>
        void verifyMails.push({ email: user.email, url, token }),
    },
    plugins: [magicLink({ sendMagicLink: async ({ url }) => void links.push(url) }), ...more],
    ...extra,
  });
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
    return { cookie, headers: new Headers({ cookie }) };
  }
  const post = (path: string, body: unknown, cookie: string) =>
    auth.handler(
      new Request(`${PATH}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify(body),
      }),
    );
  const get = (path: string, cookie: string) =>
    auth.handler(new Request(`${PATH}${path}`, { headers: { cookie } }));
  return { auth, storage: database.storage, verifyMails, signedIn, post, get };
}

const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

/** Moves the clock past a fresh window of one minute, as time does. */
function stale() {
  vi.setSystemTime(Date.now() + 120_000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the account options (plan 12a)", () => {
  it("refuses the options that would break a promise of core, each with its reason", () => {
    const { refusals } = checkOptions({
      baseURL: BASE,
      secret: SECRET,
      session: { freshAge: 0 },
      user: {
        changeEmail: { enabled: true, sendChangeEmailConfirmation: async () => {} },
        deleteUser: { enabled: true, sendDeleteAccountVerification: async () => {} },
      },
      account: {
        accountLinking: {
          allowDifferentEmails: true,
          trustedProviders: ["google"],
          allowUnlinkingAll: true,
        },
      },
      databaseHooks: { verification: { create: { before: async () => {} } } },
    } as unknown as BetterAuthOptions);
    const paths = refusals.map((r) => r.split(":")[0]);
    expect(paths).toEqual(
      expect.arrayContaining([
        "session.freshAge",
        "user.changeEmail.sendChangeEmailConfirmation",
        "user.deleteUser.sendDeleteAccountVerification",
        "account.accountLinking.allowDifferentEmails",
        "account.accountLinking.trustedProviders",
        "account.accountLinking.allowUnlinkingAll",
        "databaseHooks.verification",
        // user.changeEmail needs the mail callback of the change link.
        "emailVerification.sendVerificationEmail",
      ]),
    );
    expect(refusals.find((r) => r.startsWith("session.freshAge"))).toContain(
      "the fresh rule is a promise of core",
    );
  });

  it("accepts the options that map, with a note on the account hooks", () => {
    const c = checkOptions({
      baseURL: BASE,
      secret: SECRET,
      database: memoryDatabase(),
      session: { freshAge: 600 },
      emailVerification: { sendVerificationEmail: async () => {} },
      user: {
        changeEmail: { enabled: true, updateEmailWithoutVerification: false },
        deleteUser: { enabled: true, beforeDelete: async () => {}, afterDelete: async () => {} },
      },
      account: {
        accountLinking: { enabled: true, allowDifferentEmails: false, allowUnlinkingAll: false },
      },
      databaseHooks: {
        user: { create: { before: async () => {} }, delete: { after: async () => {} } },
        account: { delete: { before: async () => {} } },
      },
    });
    expect(c.refusals).toEqual([]);
    expect(c.notes.map((n) => n.split(":")[0])).toEqual(["account"]);
  });

  it("maps freshAge up to whole minutes, deleteUser.enabled to account.delete, and turns the notices off", () => {
    const at = (o: Partial<BetterAuthOptions>) =>
      mapOptions({ baseURL: BASE, secret: SECRET, database: memoryDatabase(), ...o });
    expect(at({ session: { freshAge: 3600 } }).config.session?.freshMinutes).toBe(60);
    expect(at({ session: { freshAge: 90 } }).config.session?.freshMinutes).toBe(2);
    expect(at({ session: { freshAge: 1 } }).config.session?.freshMinutes).toBe(1);
    expect(at({}).config.session?.freshMinutes).toBe(1440);
    expect(at({ user: { deleteUser: { enabled: true } } }).config.account?.delete).toBe(true);
    // mapOptions({}): Better Auth's defaults, the delete off and the notices off.
    expect(at({}).config.account).toEqual({
      delete: false,
      notices: false,
      mail: compatAccountMail,
    });
    expect(at({}).account).toEqual({
      changeEmail: false,
      deleteUser: false,
      emailOtpChange: false,
    });
    expect(
      at({
        user: { changeEmail: { enabled: true }, deleteUser: { enabled: true } },
        plugins: [
          emailOTP({ sendVerificationOTP: async () => {}, changeEmail: { enabled: true } }),
        ],
      }).account,
    ).toEqual({ changeEmail: true, deleteUser: true, emailOtpChange: true });
  });
});

describe("the Better Auth account paths (plan 12a)", () => {
  it("lists the sessions with the id as the token, and revokes one by that id or by its clear token", async () => {
    const t = instance();
    const a = await t.signedIn("ada@example.com");
    const b = await t.signedIn("ada@example.com");
    const c = await t.signedIn("ada@example.com");
    const d = await t.signedIn("ada@example.com");
    const list = (await (await t.get("/list-sessions", a.cookie)).json()) as Record<
      string,
      unknown
    >[];
    expect(list).toHaveLength(4);
    for (const s of list) expect(s.token).toBe(s.id);
    const userId = (await t.auth.api.getSession({ headers: a.headers }))?.user.id;
    expect(list.every((s) => s.userId === userId && typeof s.updatedAt === "string")).toBe(true);
    const listed = await t.auth.api.listSessions({ headers: a.headers });
    expect(listed.map((s) => [s.id, s.token, s.userId])).toEqual(
      list.map((s) => [s.id, s.id, userId]),
    );
    const idOf = async (h: Headers) => (await t.auth.api.getSession({ headers: h }))?.session.id;
    const res = await t.post("/revoke-session", { token: await idOf(a.headers) }, b.cookie);
    expect(await res.json()).toEqual({ status: true });
    expect(await t.auth.api.getSession({ headers: a.headers })).toBeNull();
    // The clear token of a session, as Better Auth takes it: on the handler and on the api.
    const clear = (x: { cookie: string }) => x.cookie.slice(`${COOKIE_NAME}=`.length);
    expect(await (await t.post("/revoke-session", { token: clear(c) }, b.cookie)).json()).toEqual({
      status: true,
    });
    expect(await t.auth.api.getSession({ headers: c.headers })).toBeNull();
    expect(
      await t.auth.api.revokeSession({ body: { token: clear(d) }, headers: b.headers }),
    ).toEqual({ status: true });
    expect(await t.auth.api.getSession({ headers: d.headers })).toBeNull();
    expect(await t.auth.api.listSessions({ headers: b.headers })).toHaveLength(1);
    // Better Auth answers status true for a token it does not know, too.
    expect(await (await t.post("/revoke-session", { token: "nope" }, b.cookie)).json()).toEqual({
      status: true,
    });
    expect(await t.auth.api.revokeSession({ body: { token: "nope" }, headers: b.headers })).toEqual(
      { status: true },
    );
  });

  it("revokes the other sessions, then every session with the caller's", async () => {
    const t = instance();
    const a = await t.signedIn("ada@example.com");
    const b = await t.signedIn("ada@example.com");
    expect(await (await t.post("/revoke-other-sessions", {}, b.cookie)).json()).toEqual({
      status: true,
    });
    expect(await t.auth.api.getSession({ headers: a.headers })).toBeNull();
    expect(await t.auth.api.getSession({ headers: b.headers })).not.toBeNull();
    const c = await t.signedIn("ada@example.com");
    const all = await t.post("/revoke-sessions", {}, c.cookie);
    expect(await all.json()).toEqual({ status: true });
    // Core's revoke of the caller's own session clears the cookie.
    expect(all.headers.getSetCookie().some((x) => x.startsWith(`${COOKIE_NAME}=;`))).toBe(true);
    expect(await t.auth.api.getSession({ headers: b.headers })).toBeNull();
    expect(await t.auth.api.getSession({ headers: c.headers })).toBeNull();
    // The same two on the api, for another user: the magic link limits each address.
    const d = await t.signedIn("bob@example.com");
    const e = await t.signedIn("bob@example.com");
    expect(await t.auth.api.revokeOtherSessions({ headers: e.headers })).toEqual({ status: true });
    expect(await t.auth.api.getSession({ headers: d.headers })).toBeNull();
    const f = await t.signedIn("bob@example.com");
    expect(await t.auth.api.revokeSessions({ headers: f.headers })).toEqual({ status: true });
    expect(await t.auth.api.getSession({ headers: e.headers })).toBeNull();
    expect(await t.auth.api.getSession({ headers: f.headers })).toBeNull();
  });

  it("updates the name, refuses the address with EMAIL_CAN_NOT_BE_UPDATED, and another field with FIELD_NOT_ALLOWED", async () => {
    const t = instance();
    const a = await t.signedIn("ada@example.com");
    expect(await (await t.post("/update-user", { name: "Ada" }, a.cookie)).json()).toEqual({
      status: true,
    });
    expect((await t.auth.api.getSession({ headers: a.headers }))?.user.name).toBe("Ada");
    const email = await t.post("/update-user", { email: "x@example.com" }, a.cookie);
    expect(email.status).toBe(400);
    expect(await codeOf(email)).toBe("EMAIL_CAN_NOT_BE_UPDATED");
    const field = await t.post("/update-user", { name: "Eve", role: "admin" }, a.cookie);
    expect(field.status).toBe(400);
    expect(await codeOf(field)).toBe("FIELD_NOT_ALLOWED");
    expect((await t.auth.api.getSession({ headers: a.headers }))?.user.name).toBe("Ada");
    // The same on the api; an empty name is Better Auth's "no name".
    expect(await t.auth.api.updateUser({ body: { name: "" }, headers: a.headers })).toEqual({
      status: true,
    });
    expect(
      await t.storage.findOne("user", [{ field: "email", op: "eq", value: "ada@example.com" }]),
    ).toMatchObject({ name: null });
    for (const [body, code] of [
      [{ email: "x@example.com" }, "EMAIL_CAN_NOT_BE_UPDATED"],
      [{ name: "Eve", role: "admin" }, "FIELD_NOT_ALLOWED"],
    ] as const)
      await expect(t.auth.api.updateUser({ body, headers: a.headers })).rejects.toMatchObject({
        statusCode: 400,
        body: { code },
      });
  });

  it("changes the address through sendVerificationEmail to the new address, and sends nothing for a taken one", async () => {
    const t = instance({ user: { changeEmail: { enabled: true } } });
    const a = await t.signedIn("ada@example.com");
    await t.signedIn("bob@example.com");
    expect(
      await (await t.post("/change-email", { newEmail: "ada.new@example.com" }, a.cookie)).json(),
    ).toEqual({ status: true });
    const mail = t.verifyMails.at(-1);
    expect(mail?.email).toBe("ada.new@example.com");
    expect(mail?.url).toContain("/api/auth/user/change-email/confirm?token=ec_");
    // The link is core's proof: the confirm moves the address.
    const confirmed = await t.auth.tempo.api.user.confirmEmailChange({
      token: mail?.token ?? "",
      ip: null,
      userAgent: null,
    });
    expect(confirmed.ok).toBe(true);
    expect((await t.auth.api.getSession({ headers: a.headers }))?.user.email).toBe(
      "ada.new@example.com",
    );
    const before = t.verifyMails.length;
    expect(
      await (await t.post("/change-email", { newEmail: "bob@example.com" }, a.cookie)).json(),
    ).toEqual({ status: true });
    expect(t.verifyMails).toHaveLength(before);
    // The api mails the same link.
    expect(
      await t.auth.api.changeEmail({
        body: { newEmail: "ada.api@example.com" },
        headers: a.headers,
      }),
    ).toEqual({ status: true });
    expect(t.verifyMails.at(-1)?.email).toBe("ada.api@example.com");
  });

  it("answers CHANGE_EMAIL_DISABLED, and 404 on core's change, delete, and code paths, unless the options turn them on", async () => {
    const t = instance();
    const a = await t.signedIn("ada@example.com");
    const change = await t.post("/change-email", { newEmail: "n@example.com" }, a.cookie);
    expect(change.status).toBe(400);
    expect(await codeOf(change)).toBe("CHANGE_EMAIL_DISABLED");
    expect(
      (await t.post("/user/change-email", { newEmail: "n@example.com" }, a.cookie)).status,
    ).toBe(404);
    expect((await t.post("/delete-user", {}, a.cookie)).status).toBe(404);
    // The option comes first, as in Better Auth 1.7.2: a mailed delete's token answers 404 too.
    expect((await t.post("/delete-user", { token: "t" }, a.cookie)).status).toBe(404);
    expect((await t.post("/user/delete", {}, a.cookie)).status).toBe(404);
    // Better Auth has no re-authentication code.
    expect((await t.post("/reauth/email", {}, a.cookie)).status).toBe(404);
    await expect(
      t.auth.api.changeEmail({ body: { newEmail: "n@example.com" }, headers: a.headers }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: "CHANGE_EMAIL_DISABLED" } });
    for (const body of [{}, { token: "t" }])
      await expect(t.auth.api.deleteUser({ body, headers: a.headers })).rejects.toMatchObject({
        statusCode: 404,
      });
    expect(await t.auth.api.getSession({ headers: a.headers })).not.toBeNull();
  });

  it("deletes the user with Better Auth's answer, clears core's cookie, and runs the hooks in Better Auth's order", async () => {
    const order: string[] = [];
    const t = instance({
      user: {
        deleteUser: {
          enabled: true,
          beforeDelete: async (u) => void order.push(`deleteUser.before:${u.email}`),
          afterDelete: async (u) => void order.push(`deleteUser.after:${u.email}`),
        },
      },
      databaseHooks: {
        user: {
          delete: {
            before: async (u) => void order.push(`db.before:${u.email}`),
            after: async (u) => void order.push(`db.after:${u.email}`),
          },
        },
      },
    });
    const a = await t.signedIn("ada@example.com");
    const res = await t.post("/delete-user", {}, a.cookie);
    expect(await res.json()).toEqual({ success: true, message: "User deleted" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=;`))).toBe(true);
    expect(order).toEqual([
      "deleteUser.before:ada@example.com",
      "db.before:ada@example.com",
      "db.after:ada@example.com",
      "deleteUser.after:ada@example.com",
    ]);
    expect(
      await t.storage.findOne("user", [{ field: "email", op: "eq", value: "ada@example.com" }]),
    ).toBeNull();
  });

  it("refuses the mailed delete's token and callbackURL with NOT_SUPPORTED, and deletes nothing", async () => {
    const t = instance({ user: { deleteUser: { enabled: true } } });
    const a = await t.signedIn("ada@example.com");
    for (const body of [{ token: "t" }, { callbackURL: "/bye" }]) {
      const res = await t.post("/delete-user", body, a.cookie);
      expect(res.status).toBe(501);
      expect(await codeOf(res)).toBe("NOT_SUPPORTED");
    }
    await expect(
      t.auth.api.deleteUser({ body: { token: "t" }, headers: a.headers }),
    ).rejects.toMatchObject({ statusCode: 501, body: { code: "NOT_SUPPORTED" } });
    expect(await t.auth.api.getSession({ headers: a.headers })).not.toBeNull();
    expect(await t.auth.api.deleteUser({ body: {}, headers: a.headers })).toEqual({
      success: true,
      message: "User deleted",
    });
    expect(await t.auth.api.getSession({ headers: a.headers })).toBeNull();
  });

  it("lists no account for a magic-link user, and answers ACCOUNT_NOT_FOUND for an unknown id", async () => {
    const t = instance();
    const a = await t.signedIn("ada@example.com");
    // The magic link's `email` identity is core's own: Better Auth has no such account.
    expect(await (await t.get("/list-accounts", a.cookie)).json()).toEqual([]);
    const res = await t.post("/unlink-account", { accountId: "missing" }, a.cookie);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("ACCOUNT_NOT_FOUND");
    const id = (await t.storage.findMany("identity", [])).find((r) => r.provider === "email")?.id;
    expect(id).toBeDefined();
    expect(await codeOf(await t.post("/unlink-account", { accountId: id }, a.cookie))).toBe(
      "ACCOUNT_NOT_FOUND",
    );
    expect(await t.auth.api.listUserAccounts({ headers: a.headers })).toEqual([]);
    for (const accountId of ["missing", id ?? ""])
      await expect(
        t.auth.api.unlinkAccount({ body: { accountId }, headers: a.headers }),
      ).rejects.toMatchObject({ statusCode: 400, body: { code: "ACCOUNT_NOT_FOUND" } });
  });

  it("keeps core's Origin rule, its fetch-metadata rule, and its CORS headers on the account paths", async () => {
    const t = instance({ user: { deleteUser: { enabled: true } } });
    const a = await t.signedIn("ada@example.com");
    const from = (path: string, body: unknown, headers: Record<string, string>) =>
      t.auth.handler(
        new Request(`${PATH}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: a.cookie, ...headers },
          body: JSON.stringify(body),
        }),
      );
    const evil = { origin: "https://evil.example.com" };
    expect((await from("/update-user", { name: "Eve" }, evil)).status).toBe(403);
    expect((await from("/delete-user", {}, evil)).status).toBe(403);
    expect(
      (await from("/revoke-other-sessions", {}, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect((await t.auth.api.getSession({ headers: a.headers }))?.user.name).toBe("");
    const list = await t.auth.handler(
      new Request(`${PATH}/list-sessions`, { headers: { cookie: a.cookie, origin: BASE } }),
    );
    expect(list.headers.get("access-control-allow-origin")).toBe(BASE);
    // A preflight and another method go to core's router.
    const preflight = await t.auth.handler(
      new Request(`${PATH}/update-user`, {
        method: "OPTIONS",
        headers: { origin: BASE, "access-control-request-method": "POST" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(BASE);
    expect((await t.get("/update-user", a.cookie)).status).toBe(404);
    const update = await from("/update-user", { name: "Ada" }, { origin: BASE });
    expect(update.headers.get("access-control-allow-origin")).toBe(BASE);
    expect(await update.json()).toEqual({ status: true });
  });

  it("starts a link with Better Auth's answer, and refuses the fields core cannot keep", async () => {
    const t = instance({ socialProviders: { google: { clientId: "gid", clientSecret: "gs" } } });
    const a = await t.signedIn("ada@example.com");
    const res = await t.post("/link-social", { provider: "google", callbackURL: "/s" }, a.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; redirect: boolean };
    expect(new URL(body.url).origin).toBe("https://accounts.google.com");
    expect(body.redirect).toBe(true);
    // The binding cookie of core's link route stays on the answer.
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
    const off = await t.post(
      "/link-social",
      { provider: "google", disableRedirect: true },
      a.cookie,
    );
    expect(((await off.json()) as { redirect: boolean }).redirect).toBe(false);
    const refused = await t.post(
      "/link-social",
      { provider: "google", idToken: { token: "t" }, scopes: ["x"] },
      a.cookie,
    );
    expect(refused.status).toBe(501);
    expect(await refused.json()).toEqual({
      code: "NOT_SUPPORTED",
      message: "core takes no idToken, scopes at the link",
    });
  });

  it("changes the address by an email code with emailOTP changeEmail on, and refuses a code for another address", async () => {
    const codes: { email: string; otp: string; type: string }[] = [];
    const t = instance({}, [
      emailOTP({
        sendVerificationOTP: async (d) => void codes.push(d),
        changeEmail: { enabled: true },
      }),
    ]);
    const a = await t.signedIn("ada@example.com");
    // Core serves a re-authentication code with email codes on; Better Auth has none.
    expect((await t.post("/reauth/email", {}, a.cookie)).status).toBe(404);
    expect(
      await (
        await t.post(
          "/email-otp/request-email-change",
          { newEmail: "ada.new@example.com" },
          a.cookie,
        )
      ).json(),
    ).toEqual({ success: true });
    const sent = codes.at(-1);
    expect(sent).toMatchObject({ email: "ada.new@example.com", type: "change-email" });
    const other = await t.post(
      "/email-otp/change-email",
      { newEmail: "eve@example.com", otp: sent?.otp },
      a.cookie,
    );
    expect(other.status).toBe(400);
    expect(await codeOf(other)).toBe("INVALID_OTP");
    expect((await t.auth.api.getSession({ headers: a.headers }))?.user.email).toBe(
      "ada@example.com",
    );
    expect(
      await (
        await t.post(
          "/email-otp/change-email",
          { newEmail: "ada.new@example.com", otp: sent?.otp },
          a.cookie,
        )
      ).json(),
    ).toEqual({ success: true });
    expect(await t.auth.api.getSession({ headers: a.headers })).toMatchObject({
      user: { email: "ada.new@example.com" },
    });
  });
});

describe("the fresh rule under the shim (plan 12a)", () => {
  it("opens a session with freshAt at the shim's sign-in", async () => {
    const t = instance();
    const a = await t.signedIn("ada@example.com");
    const id = (await t.auth.api.getSession({ headers: a.headers }))?.session.id ?? "";
    const row = await t.storage.findOne("session", [{ field: "id", op: "eq", value: id }]);
    expect(row?.freshAt).toBeInstanceOf(Date);
  });

  it("answers SESSION_NOT_FRESH on the account paths from a stale session, and lists the sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = instance({
      session: { freshAge: 60 },
      user: { changeEmail: { enabled: true }, deleteUser: { enabled: true } },
    });
    const a = await t.signedIn("ada@example.com");
    stale();
    const cases: [string, unknown][] = [
      ["/revoke-session", { token: "nope" }],
      ["/revoke-other-sessions", {}],
      ["/revoke-sessions", {}],
      ["/change-email", { newEmail: "n@example.com" }],
      // An unknown id answers SESSION_NOT_FRESH first, as in Better Auth 1.7.2.
      ["/unlink-account", { accountId: "missing" }],
      ["/delete-user", {}],
    ];
    for (const [path, body] of cases) {
      const res = await t.post(path, body, a.cookie);
      expect({ path, status: res.status, code: await codeOf(res) }).toEqual({
        path,
        status: 403,
        code: BETTER_AUTH_CODES.session_not_fresh,
      });
    }
    expect((await t.get("/list-sessions", a.cookie)).status).toBe(200);
    // The same rule on the api.
    const h = a.headers;
    const calls: [string, () => Promise<unknown>][] = [
      ["revokeSession", () => t.auth.api.revokeSession({ body: { token: "nope" }, headers: h })],
      ["revokeOtherSessions", () => t.auth.api.revokeOtherSessions({ headers: h })],
      ["revokeSessions", () => t.auth.api.revokeSessions({ headers: h })],
      [
        "changeEmail",
        () => t.auth.api.changeEmail({ body: { newEmail: "n@example.com" }, headers: h }),
      ],
      ["unlinkAccount", () => t.auth.api.unlinkAccount({ body: { accountId: "x" }, headers: h })],
      ["deleteUser", () => t.auth.api.deleteUser({ body: {}, headers: h })],
    ];
    for (const [name, call] of calls)
      expect({
        name,
        code: await call().catch((e: { body?: { code?: string } }) => e.body?.code),
      }).toEqual({
        name,
        code: BETTER_AUTH_CODES.session_not_fresh,
      });
    expect(await t.auth.api.listSessions({ headers: h })).toHaveLength(1);
    expect(await t.auth.api.getSession({ headers: a.headers })).not.toBeNull();
  });

  /** A password user with a session; `twoFactor` adds the plugin. */
  async function passwordUser(plugins: NonNullable<BetterAuthOptions["plugins"]>) {
    const t = instance(
      {
        session: { freshAge: 60 },
        emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
        user: { deleteUser: { enabled: true } },
        authtempo: { passwordHash: fast },
      },
      plugins,
    );
    await t.post("/password/sign-up", { email: "pat@example.com", password: PASSWORD }, "");
    await t.post("/password/verify", { token: t.verifyMails.at(-1)?.token }, "");
    const signIn = await t.post(
      "/password/sign-in",
      { email: "pat@example.com", password: PASSWORD },
      "",
    );
    const cookie = sessionPair(signIn);
    return { ...t, cookie, headers: new Headers({ cookie }) };
  }

  it("deletes from a stale session with the password, as Better Auth's password path skips freshAge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = await passwordUser([]);
    stale();
    await expect(
      t.auth.api.deleteUser({ body: { password: "wrong password here" }, headers: t.headers }),
    ).rejects.toMatchObject({ body: { code: BETTER_AUTH_CODES.invalid_credentials } });
    expect(
      await codeOf(await t.post("/delete-user", { password: "wrong password here" }, t.cookie)),
    ).toBe(BETTER_AUTH_CODES.invalid_credentials);
    expect(await codeOf(await t.post("/delete-user", {}, t.cookie))).toBe("SESSION_NOT_FRESH");
    // The credential account's unlink checks the fresh rule first, as Better Auth 1.7.2 does.
    const pw = (await t.storage.findMany("password", []))[0]?.id ?? "";
    expect(await codeOf(await t.post("/unlink-account", { accountId: pw }, t.cookie))).toBe(
      "SESSION_NOT_FRESH",
    );
    await expect(
      t.auth.api.unlinkAccount({ body: { accountId: pw }, headers: t.headers }),
    ).rejects.toMatchObject({ body: { code: "SESSION_NOT_FRESH" } });
    const res = await t.post("/delete-user", { password: PASSWORD }, t.cookie);
    expect(await res.json()).toEqual({ success: true, message: "User deleted" });
    expect(
      await t.storage.findOne("user", [{ field: "email", op: "eq", value: "pat@example.com" }]),
    ).toBeNull();
    // The api's password path.
    const u = await passwordUser([]);
    stale();
    expect(
      await u.auth.api.deleteUser({ body: { password: PASSWORD }, headers: u.headers }),
    ).toEqual({ success: true, message: "User deleted" });
    expect(await u.storage.findMany("user", [])).toEqual([]);
  });

  it("answers SESSION_NOT_FRESH on the password change of a user with the factor on, and keeps the hash", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = await passwordUser([twoFactor({ accountLockout: { enabled: false } })]);
    const enable = await t.post("/two-factor/enable", { password: PASSWORD }, t.cookie);
    const uri = ((await enable.json()) as { totpURI: string }).totpURI;
    const secret = base32Decode(new URL(uri).searchParams.get("secret") ?? "");
    const confirm = await t.post(
      "/two-factor/verify-totp",
      { code: await totpCode(secret, new Date()) },
      t.cookie,
    );
    expect(confirm.status).toBe(200);
    const hash = async () =>
      (await t.storage.findMany("password", []))[0]?.hash ?? "no password row";
    const before = await hash();
    stale();
    const res = await t.post(
      "/password/change",
      { currentPassword: PASSWORD, newPassword: "another long password" },
      t.cookie,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "session_not_fresh", code: "SESSION_NOT_FRESH" });
    expect(await hash()).toBe(before);
  });
});

describe("the fresh rule on the shim's second-factor paths (plan 12a, Task 12 review M1)", () => {
  it("answers SESSION_NOT_FRESH on the disable, the URI, and the backup codes from a stale session, changes no row, and passes after a re-authentication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = instance(
      {
        session: { freshAge: 60 },
        emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
        authtempo: { passwordHash: fast },
      },
      [twoFactor({ accountLockout: { enabled: false } })],
    );
    await t.post("/password/sign-up", { email: "pat@example.com", password: PASSWORD }, "");
    await t.post("/password/verify", { token: t.verifyMails.at(-1)?.token }, "");
    const cookie = sessionPair(
      await t.post("/password/sign-in", { email: "pat@example.com", password: PASSWORD }, ""),
    );
    const enable = await t.post("/two-factor/enable", { password: PASSWORD }, cookie);
    const uri = ((await enable.json()) as { totpURI: string }).totpURI;
    const secret = base32Decode(new URL(uri).searchParams.get("secret") ?? "");
    const code = async () => totpCode(secret, new Date());
    expect((await t.post("/two-factor/verify-totp", { code: await code() }, cookie)).status).toBe(
      200,
    );
    const rows = async () =>
      JSON.stringify([
        await t.storage.findMany("totp", []),
        await t.storage.findMany("secondFactor", []),
      ]);
    const before = await rows();
    stale();
    const paths = [
      "/two-factor/get-totp-uri",
      "/two-factor/generate-backup-codes",
      "/two-factor/disable",
    ];
    // The right password and a wrong one: the rule comes before the password check.
    for (const path of paths)
      for (const password of [PASSWORD, "wrong password here"]) {
        const res = await t.post(path, { password }, cookie);
        expect({ path, password, status: res.status, code: await codeOf(res) }).toEqual({
          path,
          password,
          status: 403,
          code: "SESSION_NOT_FRESH",
        });
      }
    expect(await rows()).toBe(before);
    // A re-authentication with the password and the code makes the session fresh again.
    expect(
      (await t.post("/reauth", { password: PASSWORD, code: await code() }, cookie)).status,
    ).toBe(200);
    expect((await t.post(paths[0] ?? "", { password: PASSWORD }, cookie)).status).toBe(200);
    expect((await t.post(paths[1] ?? "", { password: PASSWORD }, cookie)).status).toBe(200);
    expect(await (await t.post(paths[2] ?? "", { password: PASSWORD }, cookie)).json()).toEqual({
      status: true,
    });
    expect(await t.storage.findMany("secondFactor", [])).toEqual([]);
  });
});

describe("the user hooks of the shim (plan 12a)", () => {
  it("maps databaseHooks.user.create.before: { data: { name } } sets the name, another field is dropped with one line, and false refuses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const named = instance({
        databaseHooks: {
          user: { create: { before: async (u) => ({ data: { ...u, name: "Guest", role: "x" } }) } },
        },
      });
      await named.signedIn("ada@example.com");
      await named.signedIn("ann@example.com");
      const row = await named.storage.findOne("user", [
        { field: "email", op: "eq", value: "ada@example.com" },
      ]);
      expect(row?.name).toBe("Guest");
      expect(
        log.mock.calls.filter((c) => String(c[0]).includes("databaseHooks.user.create.before")),
      ).toHaveLength(1);
      const closed = instance({
        databaseHooks: { user: { create: { before: async () => false } } },
      });
      await expect(closed.signedIn("bob@example.com")).rejects.toThrow();
      expect(
        await closed.storage.findOne("user", [
          { field: "email", op: "eq", value: "bob@example.com" },
        ]),
      ).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("maps databaseHooks.user.update: the before hook gets the fields and can refuse, the after hook gets the user", async () => {
    const seen: unknown[] = [];
    let refuse = false;
    const t = instance({
      databaseHooks: {
        user: {
          update: {
            before: async (data) => {
              seen.push(data);
              return refuse ? false : undefined;
            },
            after: async (u) => void seen.push(`after:${u.name}`),
          },
        },
      },
    });
    const a = await t.signedIn("ada@example.com");
    expect(await (await t.post("/update-user", { name: "Ada" }, a.cookie)).json()).toEqual({
      status: true,
    });
    expect(seen).toEqual([{ name: "Ada" }, "after:Ada"]);
    refuse = true;
    const res = await t.post("/update-user", { name: "Eve" }, a.cookie);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("HOOK_REFUSED");
    expect((await t.auth.api.getSession({ headers: a.headers }))?.user.name).toBe("Ada");
  });
});

// Rows as Better Auth 1.7 writes them, inserted before the migration as a
// real move does (the plan 12a Task 9 precedent). They hold a verified user
// with a Google account and a credential account. Core's own writers reach
// the same state by a Google sign-in and a password sign-up; the test has no Google.
const AT = "2026-09-01T00:00:00.000Z";
// A Better Auth scrypt hash; no test signs in with it.
const BA_HASH =
  "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";
const ERA_ROWS = [
  `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('era','Era','era@example.com',true,NULL,'${AT}','${AT}');`,
  `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('era-google','${issuerFor("google")}','g-era','google','era',NULL,'${AT}','${AT}');`,
  `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('era-cred','${issuerFor("credential")}','era','credential','era','${BA_HASH}','${AT}','${AT}');`,
].join("\n");

describe("the accounts on Better Auth rows (plan 12a)", () => {
  let pg: { sql: Sql; close(): Promise<void> } | null = null;
  afterEach(async () => {
    await pg?.close();
    pg = null;
  });

  it("lists the provider and the credential account, unlinks the provider with the account hooks, and refuses the credential", async () => {
    pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    await pg.sql.unsafe(ERA_ROWS);
    const db = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await db.migrate();
    const hooks: unknown[] = [];
    const t = instance(
      {
        socialProviders: { google: { clientId: "gid", clientSecret: "gs" } },
        databaseHooks: {
          account: {
            delete: {
              before: async (x) => void hooks.push({ before: x }),
              after: async (x) => void hooks.push({ after: x }),
            },
          },
        },
      },
      [],
      db,
    );
    const a = await t.signedIn("era@example.com");
    const accounts = (await (await t.get("/list-accounts", a.cookie)).json()) as Record<
      string,
      unknown
    >[];
    expect(accounts.map((x) => [x.id, x.providerId, x.accountId, x.userId, x.scopes])).toEqual([
      ["era-google", "google", "g-era", "era", []],
      ["era-cred", "credential", "era", "era", []],
    ]);
    expect(
      (await t.auth.api.listUserAccounts({ headers: a.headers })).map((x) => [x.id, x.providerId]),
    ).toEqual([
      ["era-google", "google"],
      ["era-cred", "credential"],
    ]);
    const cred = await t.post("/unlink-account", { accountId: "era-cred" }, a.cookie);
    expect(cred.status).toBe(501);
    expect(await codeOf(cred)).toBe("NOT_SUPPORTED");
    await expect(
      t.auth.api.unlinkAccount({ body: { accountId: "era-cred" }, headers: a.headers }),
    ).rejects.toMatchObject({ statusCode: 501, body: { code: "NOT_SUPPORTED" } });
    expect(
      await (await t.post("/unlink-account", { accountId: "era-google" }, a.cookie)).json(),
    ).toEqual({ status: true });
    const fields = { providerId: "google", accountId: "g-era", userId: "era" };
    expect(hooks).toEqual([{ before: fields }, { after: fields }]);
    const again = await t.post("/unlink-account", { accountId: "era-google" }, a.cookie);
    expect(await codeOf(again)).toBe("ACCOUNT_NOT_FOUND");
    expect(
      ((await (await t.get("/list-accounts", a.cookie)).json()) as { id: string }[]).map(
        (x) => x.id,
      ),
    ).toEqual(["era-cred"]);
  });
});
