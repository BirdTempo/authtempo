import {
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  type JwtSeam,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import readme from "../README.md?raw";
import { betterAuthMethod, createAuthClient } from "../src/client/create-auth-client.js";
import { lastLoginMethodClient } from "../src/client/plugins.js";
import { APIError } from "../src/errors.js";
import {
  anonymous,
  emailOTP,
  lastLoginMethod,
  multiSession,
  oneTap,
  passkey,
  phoneNumber,
  twoFactor,
  username,
} from "../src/plugins.js";
import { createHandler } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type {
  BetterAuthOptions,
  CompatDatabase,
  EmailCallbackData,
  PhoneNumberOptions,
} from "../src/types.js";
import {
  BASE,
  betterAuth,
  betterAuthTables,
  browser,
  fastHash,
  json,
  PASSWORD,
  signInOptions,
} from "./sign-in-helpers.js";

// Plan 12i Task 16: one test per row of the mapping table. Each runs on
// Better Auth 1.7.2's own tables on the compat storage, with Better Auth's
// request and answer shapes (each plugin source read 2026-10-25).

const refusalsOf = (options: Partial<BetterAuthOptions>) =>
  checkOptions({ baseURL: BASE, secret: "s", ...options } as BetterAuthOptions).refusals.filter(
    (r) => r.startsWith("plugins") || r.startsWith("authtempo") || r.startsWith("socialProviders"),
  );

describe("the anonymous plugin", () => {
  it("signs in at /sign-in/anonymous with Better Auth's placeholder, refuses a second one, and deletes at /delete-anonymous-user", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(signInOptions(t.database, { plugins: [anonymous()] }));
    const b = browser(auth.handler);
    const res = await b.send("/sign-in/anonymous", {});
    expect(res.status).toBe(200);
    const body = await json(res);
    const user = body.user as { id: string; email: string; name: string };
    expect(body.token).toEqual(expect.stringMatching(/^ts_/));
    // Better Auth's own default name and placeholder (anonymous/index.mjs:91 and :97).
    expect(user).toMatchObject({
      name: "Anonymous",
      email: `${user.id}@anonymous.placeholder.invalid`,
    });
    expect(t.row('SELECT email, isAnonymous, name FROM "user" WHERE id = ?', user.id)).toEqual({
      email: `${user.id}@anonymous.placeholder.invalid`,
      isAnonymous: 1,
      name: "Anonymous",
    });
    // Core reads the placeholder as no address.
    const stored = await t.database.storage.findOne("user", [
      { field: "id", op: "eq", value: user.id },
    ]);
    expect(stored).toMatchObject({ email: null, isAnonymous: true });
    // Better Auth answers a second anonymous sign-in of the same browser 400 (anonymous/index.mjs:96).
    const again = await b.send("/sign-in/anonymous", {});
    expect([again.status, (await json(again)).code]).toEqual([
      400,
      "ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY",
    ]);
    const gone = await b.send("/delete-anonymous-user", {});
    expect([gone.status, await json(gone)]).toEqual([200, { success: true }]);
    expect(t.row('SELECT id FROM "user" WHERE id = ?', user.id)).toBeUndefined();
  });

  it("writes temp-<id>@<emailDomainName>, reads it as no address, and names the user by generateName", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(
      signInOptions(t.database, {
        plugins: [
          anonymous({ emailDomainName: "anon.example.com", generateName: () => "Guest 7" }),
        ],
      }),
    );
    const { send } = browser(auth.handler);
    const user = (await json(await send("/sign-in/anonymous", {}))).user as { id: string };
    expect(t.row('SELECT email, name FROM "user" WHERE id = ?', user.id)).toEqual({
      email: `temp-${user.id}@anon.example.com`,
      name: "Guest 7",
    });
    const stored = await t.database.storage.findMany("user", [
      { field: "email", op: "eq", value: null },
    ]);
    expect(stored.map((u) => u.id)).toEqual([user.id]);
    // A real address on that domain stays an address: only the temp- form is a placeholder.
    const signUp = await auth.api.signUpEmail({
      body: { email: "staff@anon.example.com", password: PASSWORD, name: "Staff" },
    });
    expect(signUp.user.email).toBe("staff@anon.example.com");
    // A second instance on the same tables with another domain would misread the rows.
    expect(() =>
      betterAuth(
        signInOptions(t.database, { plugins: [anonymous({ emailDomainName: "x.example.com" })] }),
      ),
    ).toThrow(/another instance on this database reads anon\.example\.com/);
  });

  it("runs onLinkAccount at a sign-up over the anonymous session, then deletes the anonymous user", async () => {
    const t = await betterAuthTables();
    const links: unknown[] = [];
    const auth = betterAuth(
      signInOptions(t.database, {
        plugins: [anonymous({ onLinkAccount: (d) => void links.push(d) })],
      }),
    );
    const { send } = browser(auth.handler);
    const anon = (await json(await send("/sign-in/anonymous", {}))).user as { id: string };
    const up = await send("/password/sign-up", { email: "ada@example.com", password: PASSWORD });
    expect(up.status).toBe(200);
    const user = (await json(up)).user as { id: string };
    expect(links).toEqual([
      {
        anonymousUser: {
          user: expect.objectContaining({ id: anon.id, isAnonymous: true }),
          session: expect.objectContaining({ userId: anon.id }),
        },
        newUser: {
          user: expect.objectContaining({ id: user.id, email: "ada@example.com" }),
          session: expect.objectContaining({ userId: user.id }),
        },
        // Core's proof: the address is not verified yet, so the app moves no data.
        proof: "unverified",
      },
    ]);
    expect(t.row('SELECT id FROM "user" WHERE id = ?', anon.id)).toBeUndefined();
  });

  it("answers USER_IS_NOT_ANONYMOUS at the anonymous delete of another user, as Better Auth does (ruling 42 L4)", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(signInOptions(t.database, { plugins: [anonymous()] }));
    const { send } = browser(auth.handler);
    const up = await send("/password/sign-up", { email: "ann@example.com", password: PASSWORD });
    const id = ((await json(up)).user as { id: string }).id;
    const res = await send("/delete-anonymous-user", {});
    expect([res.status, await json(res)]).toEqual([
      403,
      { code: "USER_IS_NOT_ANONYMOUS", message: "User is not anonymous" },
    ]);
    expect(t.row('SELECT id FROM "user" WHERE id = ?', id)).toEqual({ id });
  });

  it("logs one start note when onLinkAccount is set, naming the proof field (ruling 42 I1)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const note =
      'authtempo compat: plugins[anonymous].onLinkAccount: runs for both proofs; move the anonymous data only when its argument proof is "verified"';
    const notesOf = async (o: Parameters<typeof anonymous>[0]) => {
      const t = await betterAuthTables();
      info.mockClear();
      betterAuth(signInOptions(t.database, { plugins: [anonymous(o)] }));
      return info.mock.calls.map((c) => c[0]).filter((l) => String(l).includes("onLinkAccount"));
    };
    expect(await notesOf({ onLinkAccount: () => {} })).toEqual([note]);
    expect(await notesOf({})).toEqual([]);
    info.mockRestore();
  });

  it("gives onLinkAccount the session of the sign-in, not an older session of the same user (ruling 42 I2)", async () => {
    const t = await betterAuthTables();
    const links: { newUser: { session: { id: string } | null } }[] = [];
    const auth = betterAuth(
      signInOptions(t.database, {
        plugins: [anonymous({ onLinkAccount: (d) => void links.push(d as never) })],
      }),
    );
    // The user's first session, in another browser.
    const first = browser(auth.handler);
    const up = await first.send("/password/sign-up", {
      email: "ida@example.com",
      password: PASSWORD,
    });
    const older = ((await json(up)).session as { id: string }).id;
    await new Promise((r) => setTimeout(r, 5));
    const b = browser(auth.handler);
    await b.send("/sign-in/anonymous", {});
    const res = await b.send("/password/sign-in", { email: "ida@example.com", password: PASSWORD });
    expect(res.status).toBe(200);
    const newer = ((await json(res)).session as { id: string }).id;
    expect(newer).not.toBe(older);
    expect(links.map((l) => l.newUser.session?.id)).toEqual([newer]);
  });

  it("refuses generateRandomEmail, disableDeleteAnonymousUser, schema, a bad emailDomainName, and a closed sign-up", () => {
    expect(
      refusalsOf({
        plugins: [
          anonymous({
            generateRandomEmail: () => "x@example.com",
            disableDeleteAnonymousUser: true,
            schema: {},
            emailDomainName: "Not A Host",
          }),
        ],
      }),
    ).toEqual([
      "plugins[anonymous].disableDeleteAnonymousUser: core deletes the anonymous user at each upgrade, after hooks.anonymous.afterLink",
      "plugins[anonymous].emailDomainName: expected a host in lower-case ASCII, such as example.com",
      "plugins[anonymous].generateRandomEmail: core writes the placeholder address itself (<id>@anonymous.placeholder.invalid, or temp-<id>@<emailDomainName>), so it reads every one back as no address",
      "plugins[anonymous].schema: core reads isAnonymous from Better Auth's own column",
    ]);
    expect(
      refusalsOf({
        emailAndPassword: { enabled: true, disableSignUp: true },
        plugins: [anonymous()],
      }),
    ).toEqual([
      "plugins[anonymous]: core's signUp false closes the anonymous sign-in too; remove disableSignUp or the plugin",
    ]);
  });
});

describe("the username plugin", () => {
  it("signs up with a username, signs in at /sign-in/username, answers /is-username-available, and changes it at /update-user", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(
      signInOptions(t.database, {
        plugins: [username({ minUsernameLength: 4, maxUsernameLength: 20 })],
      }),
    );
    expect(mapOptions(auth.options).config.username).toEqual({ minLength: 4, maxLength: 20 });
    const up = await auth.api.signUpEmail({
      body: { email: "ada@example.com", password: PASSWORD, name: "Ada", username: "Ada.L" },
    });
    // Better Auth's own columns: the stored form and the typed case.
    expect(t.row('SELECT username, displayUsername FROM "user" WHERE id = ?', up.user.id)).toEqual({
      username: "ada.l",
      displayUsername: "Ada.L",
    });
    const b = browser(auth.handler);
    const signedIn = await b.send("/sign-in/username", { username: "ADA.L", password: PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(await json(signedIn)).toEqual({
      token: expect.stringMatching(/^ts_/),
      user: expect.objectContaining({ id: up.user.id }),
    });
    const wrong = await browser(auth.handler).send("/sign-in/username", {
      username: "ada.l",
      password: "wrong password here",
    });
    expect([wrong.status, (await json(wrong)).code]).toEqual([401, "INVALID_EMAIL_OR_PASSWORD"]);
    const free = await b.send("/is-username-available", { username: "grace" });
    const taken = await b.send("/is-username-available", { username: "ada.l" });
    expect([await json(free), await json(taken)]).toEqual([
      { available: true },
      { available: false },
    ]);
    expect(await auth.api.isUsernameAvailable({ body: { username: "ada.l" } })).toEqual({
      available: false,
    });
    const refused = await b.send("/sign-in/username", {
      username: "ada.l",
      password: PASSWORD,
      callbackURL: "/home",
    });
    expect([refused.status, (await json(refused)).code]).toEqual([501, "NOT_SUPPORTED"]);
    // A display name that is not the typed name would be dropped: refused.
    await expect(
      auth.api.signUpEmail({
        body: {
          email: "lin@example.com",
          password: PASSWORD,
          name: "Lin",
          username: "lin",
          displayUsername: "Lin the Great",
        },
      }),
    ).rejects.toMatchObject({ body: { code: "NOT_SUPPORTED" } });
  });

  it("refuses the validators, the normalization, immutableUsername, and a username without passwords", () => {
    expect(
      refusalsOf({
        emailAndPassword: { enabled: true },
        plugins: [
          username({
            usernameValidator: () => true,
            usernameNormalization: false,
            validationOrder: { username: "post-normalization" },
            immutableUsername: true,
            minUsernameLength: 2,
          }),
        ],
      }),
    ).toEqual([
      "plugins[username].immutableUsername: core lets a user change the username",
      "plugins[username].minUsernameLength: core takes 3 to 30",
      "plugins[username].usernameNormalization: core stores the name in NFKC and lower case",
      "plugins[username].usernameValidator: core's stored form matches ^[a-z0-9_.]+$ after NFKC and lower case, so a username never reads as an address or a phone",
      "plugins[username].validationOrder: core checks the stored form after NFKC",
    ]);
    expect(refusalsOf({ plugins: [username()] })).toEqual([
      "plugins[username]: needs emailAndPassword.enabled: core's sign-in by username is a password sign-in",
    ]);
  });

  it("clears a username that Better Auth stored for an unverified user when the owner proves the address (claimedUser)", async () => {
    const t = await betterAuthTables();
    // A row as Better Auth 1.7.2 writes it at /sign-up/email with a username
    // (username/index.mjs, the user create hook): unverified, with a password.
    t.db.exec(`
      INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt","username","displayUsername")
        VALUES ('ba-squat','Squat','owner@example.com',0,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','squatter','Squatter');
    `);
    const mails: { email: string; url: string }[] = [];
    const auth = betterAuth(
      signInOptions(t.database, {
        plugins: [
          username(),
          (await import("../src/plugins.js")).magicLink({
            sendMagicLink: async (d) => void mails.push(d),
          }),
        ],
      }),
    );
    const { send } = browser(auth.handler);
    expect((await send("/magic-link/request", { email: "owner@example.com" })).status).toBe(200);
    const token = new URL(mails[0]?.url ?? "").searchParams.get("token") ?? "";
    const verified = await send("/magic-link/verify", { token });
    expect(verified.status).toBe(200);
    expect(
      t.row('SELECT emailVerified, username, displayUsername FROM "user" WHERE id = ?', "ba-squat"),
    ).toEqual({ emailVerified: 1, username: null, displayUsername: null });
  });
});

/** Options with the phone-number plugin; `sent` collects each call of sendOTP. */
function phoneOptions(
  database: CompatDatabase,
  sent: { phoneNumber: string; code: string }[],
  extra: Partial<PhoneNumberOptions> = {},
  verifies: EmailCallbackData[] = [],
): BetterAuthOptions {
  return signInOptions(
    database,
    {
      plugins: [
        phoneNumber({
          sendOTP: (d) => void sent.push(d),
          signUpOnVerification: {
            getTempEmail: (n) => `${n}@phone.placeholder.invalid`,
            getTempName: (n) => `Phone ${n.slice(-4)}`,
          },
          ...extra,
        }),
      ],
      authtempo: { passwordHash: fastHash, phone: { regions: ["+1"] } },
    },
    verifies,
  );
}

describe("the phone-number plugin", () => {
  it("sends core's code through sendOTP and signs up at /phone-number/verify with Better Auth's columns", async () => {
    const t = await betterAuthTables();
    const sent: { phoneNumber: string; code: string }[] = [];
    const auth = betterAuth(phoneOptions(t.database, sent, { otpLength: 8, expiresIn: 90 }));
    // Better Auth counts seconds; core counts whole minutes, rounded up.
    expect(mapOptions(auth.options).config.phone).toMatchObject({
      length: 8,
      ttlMinutes: 2,
      maxAttempts: 3,
      signUp: true,
      regions: ["+1"],
    });
    const { send } = browser(auth.handler);
    const asked = await send("/phone-number/send-otp", { phoneNumber: "+14155550123" });
    expect([asked.status, await json(asked)]).toEqual([200, { message: "code sent" }]);
    // The code that core made reaches sendOTP: the wrapper is the one place that passes it on.
    // Core sends after the answer (ruling 23); with no waitUntil on Node, the send runs detached.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toEqual([{ phoneNumber: "+14155550123", code: expect.stringMatching(/^\d{8}$/) }]);
    const verified = await send("/phone-number/verify", {
      phoneNumber: "+14155550123",
      code: sent[0]?.code,
    });
    expect(verified.status).toBe(200);
    const body = await json(verified);
    const user = body.user as { id: string };
    expect(body).toMatchObject({ status: true, token: expect.stringMatching(/^ts_/) });
    expect(
      t.row(
        'SELECT email, name, phoneNumber, phoneNumberVerified FROM "user" WHERE id = ?',
        user.id,
      ),
    ).toEqual({
      email: `${user.id}@anonymous.placeholder.invalid`,
      name: "Phone 0123",
      phoneNumber: "+14155550123",
      phoneNumberVerified: 1,
    });
    // A wrong code answers Better Auth's shape with core's status.
    await send("/phone-number/send-otp", { phoneNumber: "+14155550124" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const wrong = await send("/phone-number/verify", {
      phoneNumber: "+14155550124",
      code: "00000000",
    });
    expect([wrong.status, (await json(wrong)).code]).toEqual([400, "INVALID_OTP"]);
  });

  it("adds a number with updatePhoneNumber and signs in at /sign-in/phone-number", async () => {
    const t = await betterAuthTables();
    const sent: { phoneNumber: string; code: string }[] = [];
    const verifies: EmailCallbackData[] = [];
    const auth = betterAuth(phoneOptions(t.database, sent, {}, verifies));
    const { send } = browser(auth.handler);
    expect(
      (await send("/password/sign-up", { email: "pat@example.com", password: PASSWORD })).status,
    ).toBe(200);
    // The address proof first: core adds a phone to a proved account only.
    expect((await send("/password/verify", { token: verifies[0]?.token })).status).toBe(200);
    await send("/phone-number/send-otp", { phoneNumber: "+14155550150" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const added = await send("/phone-number/verify", {
      phoneNumber: "+14155550150",
      code: sent[0]?.code,
      updatePhoneNumber: true,
    });
    expect(added.status).toBe(200);
    expect(await json(added)).toMatchObject({ status: true, user: { email: "pat@example.com" } });
    const other = browser(auth.handler);
    const signedIn = await other.send("/sign-in/phone-number", {
      phoneNumber: "+14155550150",
      password: PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    expect(await json(signedIn)).toMatchObject({
      token: expect.stringMatching(/^ts_/),
      user: { email: "pat@example.com" },
    });
    const reset = await other.send("/phone-number/request-password-reset", {
      phoneNumber: "+14155550150",
    });
    expect([reset.status, (await json(reset)).code]).toEqual([501, "NOT_SUPPORTED"]);
  });

  it("refuses verifyOTP and every key core cannot keep, and needs authtempo.phone.regions", () => {
    const sendOTP = () => {};
    expect(
      refusalsOf({
        plugins: [
          phoneNumber({
            sendOTP,
            verifyOTP: () => true,
            phoneNumberValidator: () => true,
            callbackOnVerification: () => {},
            sendPasswordResetOTP: () => {},
          }),
        ],
      }),
    ).toEqual([
      'authtempo.phone.regions: required by plugins[phone-number]: the calling-code prefixes that get an SMS, such as ["+1"]; core has no default',
      "plugins[phone-number].callbackOnVerification: core has no hook at a phone proof; use databaseHooks.user or the session hooks",
      "plugins[phone-number].phoneNumberValidator: core takes E.164 numbers under authtempo.phone.regions only",
      "plugins[phone-number].sendPasswordResetOTP: core has no password reset by phone; /phone-number/request-password-reset answers NOT_SUPPORTED",
      "plugins[phone-number].verifyOTP: core checks every code itself: a keyed hash, one compare, and a count of each guess; a check of the app would keep that promise alone",
    ]);
    expect(
      refusalsOf({
        plugins: [phoneNumber({ sendOTP, expiresIn: 1200, otpLength: 4 })],
        authtempo: { phone: { regions: ["+1"] } },
      }),
    ).toEqual([
      "plugins[phone-number].expiresIn: core takes 60 to 600 seconds, rounded up to whole minutes",
      "plugins[phone-number].otpLength: core makes 6 or 8 digits",
    ]);
    expect(refusalsOf({ authtempo: { phone: { regions: ["+1"] } } })).toEqual([
      "authtempo.phone: only with plugins[phone-number]",
    ]);
    expect(
      refusalsOf({
        plugins: [phoneNumber({ sendOTP })],
        // A block with no regions, as an untyped config could hold.
        authtempo: { phone: { dailyCap: 10 } as unknown as { regions: string[] } },
      }),
    ).toEqual(["authtempo.phone.regions: required: core has no default"]);
  });

  it("signs in by code over an anonymous session and upgrades it: onLinkAccount runs (ruling 42 H1)", async () => {
    const t = await betterAuthTables();
    const sent: { phoneNumber: string; code: string }[] = [];
    const links: { proof: string; anonymousUser: { user: { id: string } } }[] = [];
    const options = phoneOptions(t.database, sent);
    const auth = betterAuth({
      ...options,
      plugins: [
        ...(options.plugins ?? []),
        anonymous({ onLinkAccount: (d) => void links.push(d as never) }),
      ],
    });
    const { send } = browser(auth.handler);
    const anon = (await json(await send("/sign-in/anonymous", {}))).user as { id: string };
    const asked = await send("/phone-number/send-otp", { phoneNumber: "+14155550170" });
    expect([asked.status, await json(asked)]).toEqual([200, { message: "code sent" }]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const verified = await send("/phone-number/verify", {
      phoneNumber: "+14155550170",
      code: sent[0]?.code,
    });
    expect(verified.status).toBe(200);
    const user = (await json(verified)).user as { id: string };
    expect(user.id).not.toBe(anon.id);
    expect(links.map((l) => [l.proof, l.anonymousUser.user.id])).toEqual([["verified", anon.id]]);
    expect(t.row('SELECT id FROM "user" WHERE id = ?', anon.id)).toBeUndefined();
    expect(t.row('SELECT phoneNumber FROM "user" WHERE id = ?', user.id)).toEqual({
      phoneNumber: "+14155550170",
    });
  });

  it("sends no note to a number that another user holds, and answers as for a free number (ruling 42 L3)", async () => {
    const t = await betterAuthTables();
    const sent: { phoneNumber: string; code: string }[] = [];
    const verifies: EmailCallbackData[] = [];
    const auth = betterAuth(phoneOptions(t.database, sent, {}, verifies));
    // The holder signs up by code.
    const holder = browser(auth.handler);
    await holder.send("/phone-number/send-otp", { phoneNumber: "+14155550180" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await holder.send("/phone-number/verify", { phoneNumber: "+14155550180", code: sent[0]?.code });
    // A proved account asks to add the taken number, then a free one.
    const { send } = browser(auth.handler);
    await send("/password/sign-up", { email: "tom@example.com", password: PASSWORD });
    expect((await send("/password/verify", { token: verifies[0]?.token })).status).toBe(200);
    const taken = await send("/phone-number/send-otp", { phoneNumber: "+14155550180" });
    const free = await send("/phone-number/send-otp", { phoneNumber: "+14155550181" });
    expect([taken.status, await json(taken)]).toEqual([free.status, await json(free)]);
    expect(free.status).toBe(200);
    // The add sends after its answer: the free number gets its code, and the taken one nothing.
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((x) => x.phoneNumber)).toEqual(["+14155550180", "+14155550181"]);
  });

  it("answers 403 to a verify with updatePhoneNumber over an anonymous session (ruling 44 L-B)", async () => {
    const t = await betterAuthTables();
    const sent: { phoneNumber: string; code: string }[] = [];
    const options = phoneOptions(t.database, sent);
    const auth = betterAuth({ ...options, plugins: [anonymous(), ...(options.plugins ?? [])] });
    const { send } = browser(auth.handler);
    const anon = await json(await send("/sign-in/anonymous", {}));
    const anonId = (anon.user as { id: string }).id;
    expect((await send("/phone-number/send-otp", { phoneNumber: "+14155550190" })).status).toBe(
      200,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const v = await send("/phone-number/verify", {
      phoneNumber: "+14155550190",
      code: sent[0]?.code,
      updatePhoneNumber: true,
    });
    // Better Auth sets the number on the anonymous user. Core refuses a phone on it.
    expect([v.status, (await json(v)).code]).toEqual([403, "ANONYMOUS_REFUSED"]);
    expect(t.row('SELECT phoneNumber, isAnonymous FROM "user" WHERE id = ?', anonId)).toEqual({
      phoneNumber: null,
      isAnonymous: 1,
    });
    expect(readme).toContain(
      "updatePhoneNumber: true`, the verify answers 403 `ANONYMOUS_REFUSED`",
    );
  });

  it("answers an add of a held and a free number before sendOTP returns (ruling 44)", async () => {
    const t = await betterAuthTables();
    const PORT_MS = 1000;
    const sent: { phoneNumber: string; code: string }[] = [];
    let returned = 0;
    let release = () => {};
    let held = Promise.resolve();
    const verifies: EmailCallbackData[] = [];
    const auth = betterAuth(
      phoneOptions(
        t.database,
        sent,
        {
          // A slow supplier (probe P1 of the Task 16 re-review waited 150 ms).
          sendOTP: async (d) => {
            sent.push(d);
            await Promise.race([held, new Promise((r) => setTimeout(r, PORT_MS))]);
            returned++;
          },
        },
        verifies,
      ),
    );
    const holder = browser(auth.handler);
    await holder.send("/phone-number/send-otp", { phoneNumber: "+14155550180" });
    await vi.waitFor(() => expect(returned).toBe(1));
    await holder.send("/phone-number/verify", { phoneNumber: "+14155550180", code: sent[0]?.code });
    const after: Promise<unknown>[] = [];
    const { send } = browser((r) => auth.handler(r, { waitUntil: (p) => void after.push(p) }));
    await send("/password/sign-up", { email: "tom@example.com", password: PASSWORD });
    expect((await send("/password/verify", { token: verifies[0]?.token })).status).toBe(200);
    await Promise.all(after);
    held = new Promise<void>((r) => {
      release = r;
    });
    const timed = async (phoneNumber: string) => {
      const before = returned;
      const t0 = performance.now();
      const res = await send("/phone-number/send-otp", { phoneNumber });
      return { ms: performance.now() - t0, portReturned: returned - before, res };
    };
    const taken = await timed("+14155550180");
    const free = await timed("+14155550181");
    release();
    await Promise.all(after);
    // Neither answer waited for sendOTP, so the time does not tell a held number.
    expect([taken.portReturned, free.portReturned]).toEqual([0, 0]);
    expect([taken.res.status, await json(taken.res)]).toEqual([
      free.res.status,
      await json(free.res),
    ]);
    expect(free.ms).toBeLessThan(PORT_MS);
    expect(Math.abs(taken.ms - free.ms)).toBeLessThan(PORT_MS / 2);
    // The free number got its code after the answer. The note to the taken number is not sent.
    expect(sent.map((x) => x.phoneNumber)).toEqual(["+14155550180", "+14155550181"]);
  });

  it("passes the host's waitUntil to core, so the SMS goes out under it after the answer (ruling 23)", async () => {
    const t = await betterAuthTables();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sent: string[] = [];
    const auth = betterAuth(
      phoneOptions(t.database, [], {
        sendOTP: async (d) => {
          await gate;
          sent.push(d.phoneNumber);
        },
      }),
    );
    const held: Promise<unknown>[] = [];
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/phone-number/send-otp`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+14155550160" }),
      }),
      { waitUntil: (p) => void held.push(p) },
    );
    expect(res.status).toBe(200);
    // One promise for the host: the SMS, then the flush.
    expect(held).toHaveLength(1);
    let settled = false;
    void Promise.all(held).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    // The host's promise waits for the send that core runs after the answer.
    expect([settled, sent]).toEqual([false, []]);
    release();
    await Promise.all(held);
    expect([settled, sent]).toEqual([true, ["+14155550160"]]);
  });
});

/** Two tokens in the compact form: core keys its used-token row on the payload part. */
const TOK1 = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnLTEifQ.c2lnMQ";
const TOK2 = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnLTIifQ.c2lnMg";
const TOK3 = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnLTMifQ.c2lnMw";

/** A fake ID token verifier: the claims of each token, as Google would sign them. */
function fakeJwt(claims: Record<string, Record<string, unknown>>): JwtSeam {
  return {
    async verifyIdToken({ token }) {
      const c = claims[token];
      if (!c) throw new Error("bad token");
      return c;
    },
    async signES256() {
      throw new Error("not used");
    },
  };
}

const googleClaims = (sub: string, email: string, nonce?: string) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: "g-client",
    sub,
    email,
    email_verified: true,
    iat: now,
    exp: now + 600,
    ...(nonce !== undefined ? { nonce } : {}),
  };
};

describe("the one-tap plugin and /sign-in/social with idToken", () => {
  it("maps One Tap to core's ID-token route for google with no nonce, and answers Better Auth's { token, user }", async () => {
    const t = await betterAuthTables();
    const options = signInOptions(t.database, {
      socialProviders: { google: { clientId: "g-client", clientSecret: "g-secret" } },
      plugins: [oneTap()],
    });
    const mapped = mapOptions(options);
    expect(mapped.config.social?.idToken).toEqual({ requireNonce: false });
    const auth = createAuth({
      ...mapped.config,
      jwt: fakeJwt({ [TOK1]: googleClaims("g-1", "tap@example.com") }),
    });
    const { send } = browser(createHandler(auth, mapped));
    const res = await send("/one-tap/callback", { idToken: TOK1 });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      token: expect.stringMatching(/^ts_/),
      user: expect.objectContaining({ email: "tap@example.com", emailVerified: true }),
    });
    expect(
      t.row('SELECT "providerId", "accountId" FROM account WHERE "providerId" = ?', "google"),
    ).toEqual({
      providerId: "google",
      accountId: "g-1",
    });
    const bad = await send("/one-tap/callback", { idToken: "unknown" });
    expect([bad.status, (await json(bad)).code]).toEqual([400, "INVALID_TOKEN"]);
    // disableSignup votes in core's one sign-up rule; One Tap needs Google.
    expect(refusalsOf({ plugins: [oneTap()] })).toEqual([
      "plugins[one-tap]: needs socialProviders.google: core verifies the ID token for its clientId",
    ]);
    expect(
      refusalsOf({
        socialProviders: { google: { clientId: "g", clientSecret: "s" } },
        plugins: [oneTap({ clientId: "other" })],
      }),
    ).toEqual([
      "plugins[one-tap].clientId: core verifies the ID token for socialProviders.google.clientId; set the same value or leave it out",
    ]);
  });

  it("signs in at /sign-in/social with an ID token and a nonce of core, and refuses another provider", async () => {
    const t = await betterAuthTables();
    const options = signInOptions(t.database, {
      socialProviders: { google: { clientId: "g-client", clientSecret: "g-secret" } },
    });
    const mapped = mapOptions(options);
    const claims: Record<string, Record<string, unknown>> = {};
    const auth = createAuth({ ...mapped.config, jwt: fakeJwt(claims) });
    const { send } = browser(createHandler(auth, mapped));
    const n = await json(await send("/social/google/id-token/nonce", {}));
    claims[TOK2] = googleClaims("g-2", "native@example.com", String(n.providerNonce));
    const res = await send("/sign-in/social", {
      provider: "google",
      idToken: { token: TOK2, nonce: n.nonce },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      redirect: false,
      token: expect.stringMatching(/^ts_/),
      user: expect.objectContaining({ email: "native@example.com" }),
    });
    const github = await send("/sign-in/social", { provider: "github", idToken: { token: "x" } });
    expect([github.status, (await json(github)).code]).toEqual([501, "NOT_SUPPORTED"]);
    // Without one-tap, core needs its own nonce: a token that has no nonce claim,
    // posted with no nonce, answers INVALID_TOKEN (ruling 42 L2).
    claims[TOK3] = googleClaims("g-3", "bare@example.com");
    const none = await send("/sign-in/social", { provider: "google", idToken: { token: TOK3 } });
    expect([none.status, (await json(none)).code]).toEqual([400, "INVALID_TOKEN"]);
  });
});

describe("the multi-session plugin", () => {
  it("lists, switches, and revokes the sessions of one browser in Better Auth's shapes", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(
      signInOptions(t.database, { plugins: [multiSession({ maximumSessions: 3 })] }),
    );
    expect(mapOptions(auth.options).config.multiSession).toEqual({ max: 3 });
    const { send } = browser(auth.handler);
    await send("/password/sign-up", { email: "a@example.com", password: PASSWORD });
    await send("/password/sign-up", { email: "b@example.com", password: PASSWORD });
    const list = await send("/multi-session/list-device-sessions");
    expect(list.status).toBe(200);
    const sessions = (await list.json()) as {
      session: { token: string; id: string };
      user: { email: string };
    }[];
    expect(sessions.map((s) => s.user.email)).toEqual(["b@example.com", "a@example.com"]);
    // The token of each entry is its session id: the shim never holds a clear token.
    for (const s of sessions) expect(s.session.token).toBe(s.session.id);
    const a = sessions[1]?.session.token ?? "";
    const switched = await send("/multi-session/set-active", { sessionToken: a });
    expect(switched.status).toBe(200);
    expect(await json(switched)).toMatchObject({
      user: { email: "a@example.com" },
      session: { id: a },
    });
    const b = sessions[0]?.session.token ?? "";
    const revoked = await send("/multi-session/revoke", { sessionToken: b });
    expect([revoked.status, await json(revoked)]).toEqual([200, { status: true }]);
    const after = (await (await send("/multi-session/list-device-sessions")).json()) as unknown[];
    expect(after).toHaveLength(1);
    expect(refusalsOf({ plugins: [multiSession({ maximumSessions: 11 })] })).toEqual([
      "plugins[multi-session].maximumSessions: core keeps 2 to 10 sessions in one browser",
    ]);
  });
});

describe("the last-login-method plugin", () => {
  it("sets core's cookie under Better Auth's name, and the client reads it in Better Auth's names", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(
      signInOptions(t.database, { plugins: [lastLoginMethod({ maxAge: 864000 })] }),
    );
    expect(mapOptions(auth.options).config.lastMethod).toEqual({
      cookieName: "better-auth.last_used_login_method",
      days: 10,
    });
    const b = browser(auth.handler);
    await b.send("/password/sign-up", { email: "l@example.com", password: PASSWORD });
    await b.send("/sign-out", {});
    const res = await b.send("/password/sign-in", { email: "l@example.com", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(b.jar.cookies.get("better-auth.last_used_login_method")).toBe("password");
    expect(
      [
        "password",
        "social:google",
        "magic_link",
        "email_otp",
        "passkey",
        "username",
        "phone",
        "other",
      ].map(betterAuthMethod),
    ).toEqual([
      "email",
      "google",
      "magic-link",
      "email-otp",
      "passkey",
      "username",
      "phone-number",
      null,
    ]);
    vi.stubGlobal("document", {
      cookie: "a=1; better-auth.last_used_login_method=social%3Agithub",
    });
    try {
      const client = createAuthClient({ baseURL: BASE, plugins: [lastLoginMethodClient()] });
      expect([client.getLastUsedLoginMethod(), client.isLastUsedLoginMethod("github")]).toEqual([
        "github",
        true,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(
      refusalsOf({
        plugins: [
          lastLoginMethod({ storeInDatabase: true, customResolveMethod: () => null, maxAge: 100 }),
        ],
      }),
    ).toEqual([
      "plugins[last-login-method].customResolveMethod: core sets the method of each sign-in itself",
      "plugins[last-login-method].maxAge: core takes whole days from 1 to 400",
      "plugins[last-login-method].storeInDatabase: core never stores the method on the user: it is a hint only",
    ]);
  });
});

describe("the presets and the provider callback path", () => {
  it("maps microsoft, discord, gitlab, twitter, and facebook with Better Auth's callback as each redirectURI", () => {
    const database: CompatDatabase = {
      kind: "authtempo-compat-database",
      dialect: "postgres",
      storage: createMemoryAdapter(),
      limiter: createMemoryLimiter(systemClock),
    };
    const options = signInOptions(database, {
      socialProviders: {
        microsoft: { clientId: "m", clientSecret: "ms", tenantId: "organizations" },
        discord: { clientId: "d", clientSecret: "ds" },
        gitlab: { clientId: "g", clientSecret: "gs", issuer: "https://gitlab.example.com" },
        twitter: { clientId: "x", clientSecret: "xs", redirectURI: `${BASE}/api/auth/x/back` },
        facebook: { clientId: "f", clientSecret: "fs" },
      },
    });
    const cb = (id: string) => `${BASE}/api/auth/callback/${id}`;
    expect(mapOptions(options).config.social).toEqual({
      microsoft: {
        clientId: "m",
        clientSecret: "ms",
        tenant: "organizations",
        redirectURI: cb("microsoft"),
      },
      discord: { clientId: "d", clientSecret: "ds", redirectURI: cb("discord") },
      gitlab: {
        clientId: "g",
        clientSecret: "gs",
        issuer: "https://gitlab.example.com",
        redirectURI: cb("gitlab"),
      },
      twitter: { clientId: "x", clientSecret: "xs", redirectURI: `${BASE}/api/auth/x/back` },
      facebook: { clientId: "f", clientSecret: "fs", redirectURI: cb("facebook") },
    });
    // On http (local work) core takes no override: the callback is core's own path.
    expect(
      mapOptions({ ...options, baseURL: "http://localhost:3000" }).config.social?.discord,
    ).toEqual({ clientId: "d", clientSecret: "ds" });
  });

  it("starts a provider with Better Auth's callback and serves it at <basePath>/callback/<id>", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(
      signInOptions(t.database, {
        socialProviders: { discord: { clientId: "d", clientSecret: "ds" } },
      }),
    );
    const { send, jar } = browser(auth.handler);
    const start = await send("/social/discord/start");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/discord`);
    // The binding cookie is on the callback path, and the path reaches core's callback.
    expect(
      start.headers.getSetCookie().some((c) => c.includes("Path=/api/auth/callback/discord")),
    ).toBe(true);
    const back = await send(
      `/callback/discord?state=${location.searchParams.get("state")}&error=access_denied`,
    );
    expect(back.status).not.toBe(404);
    expect(jar.cookies.size).toBeGreaterThanOrEqual(0);
  });
});

describe("the passkey plugin's registration", () => {
  it("maps requireSession: true and refuses the sign-up keys of deviation 6", () => {
    const pk = { rpID: "example.com", rpName: "Example", origin: BASE };
    expect(
      refusalsOf({ plugins: [passkey({ ...pk, registration: { requireSession: true } })] }),
    ).toEqual([]);
    const why =
      "core makes every user; the sign-up by passkey is core's passkey.signUp, which the shim does not map (deviation 6 of plan 12i)";
    expect(
      refusalsOf({
        plugins: [
          passkey({
            ...pk,
            registration: {
              requireSession: false,
              resolveUser: () => null,
              afterVerification: () => {},
            },
          }),
        ],
      }),
    ).toEqual([
      `plugins[passkey].registration.afterVerification: ${why}`,
      `plugins[passkey].registration.requireSession: ${why}`,
      `plugins[passkey].registration.resolveUser: ${why}`,
    ]);
  });
});

describe("the calls of auth.api", () => {
  it("answers the anonymous and username calls, throws APIError on a refusal, and 404 without the plugin", async () => {
    const t = await betterAuthTables();
    const auth = betterAuth(
      signInOptions(t.database, { plugins: [anonymous(), username(), twoFactor()] }),
    );
    const anon = await auth.api.signInAnonymous();
    expect(anon.user.email).toBe(`${anon.user.id}@anonymous.placeholder.invalid`);
    await auth.api.signUpEmail({
      body: { email: "u@example.com", password: PASSWORD, name: "U", username: "uu1" },
    });
    const signedIn = await auth.api.signInUsername({
      body: { username: "uu1", password: PASSWORD },
    });
    expect(signedIn).toMatchObject({
      token: expect.stringMatching(/^ts_/),
      user: { email: "u@example.com" },
    });
    await expect(
      auth.api.signInUsername({ body: { username: "uu1", password: "a wrong password" } }),
    ).rejects.toBeInstanceOf(APIError);
    const plain = betterAuth(signInOptions((await betterAuthTables()).database));
    await expect(plain.api.signInAnonymous()).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("the host's waitUntil at the sign-up code resend (ruling 39 Info 5, Task 20)", () => {
  it("mails the resend code under the host's waitUntil after the answer, and the README says so", async () => {
    const t = await betterAuthTables();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mailed: string[] = [];
    // With the code proof, core mails the sign-up code through sendVerificationOTP, not a link.
    const options = signInOptions(t.database, {
      plugins: [
        emailOTP({
          overrideDefaultEmailVerification: true,
          sendVerificationOTP: async (d) => {
            if (mailed.length > 0) await gate;
            mailed.push(d.type);
          },
        }),
      ],
    });
    delete options.emailVerification;
    const auth = betterAuth(options);
    const { send } = browser(auth.handler);
    expect(
      (await send("/password/sign-up", { email: "wu@example.com", password: PASSWORD })).status,
    ).toBe(200);
    await vi.waitFor(() => expect(mailed).toHaveLength(1));
    const held: Promise<unknown>[] = [];
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ email: "wu@example.com", type: "email-verification" }),
      }),
      { waitUntil: (p) => void held.push(p) },
    );
    expect([res.status, held.length]).toEqual([200, 1]);
    let settled = false;
    void Promise.all(held).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect([settled, mailed]).toEqual([false, ["email-verification"]]);
    release();
    await Promise.all(held);
    expect(mailed).toEqual(["email-verification", "email-verification"]);
    // The docs state the rule and the residual on Workers without waitUntil.
    expect(readme).toContain(
      "the handler waits for the mail on Workers. Then the answer time tells an",
    );
  });
});
