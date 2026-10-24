import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AccountConfig,
  type AuthConfig,
  ConfigError,
  type MailMessage,
} from "../src/config.js";
import {
  confirmAccountDelete,
  deleteAccount,
  requestAccountDelete,
} from "../src/engine/account-delete.js";
import {
  confirmEmailChange,
  requestEmailChange,
  verifyEmailChange,
} from "../src/engine/email-change.js";
import { requestResetOtp, resetPasswordWithOtp } from "../src/engine/email-otp.js";
import { unlinkIdentity } from "../src/engine/identities.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { defaultNoticeMail, type NoticeMailInput } from "../src/engine/notices.js";
import {
  deletePasskey,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import {
  changePassword,
  passwordSignIn,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { requestReauthCode } from "../src/engine/reauth.js";
import {
  disableMethod,
  enableEmailMethod,
  enablePasskeyMethod,
} from "../src/engine/second-factor-methods.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startLink } from "../src/engine/social.js";
import { disableTotp, disableTotpWithCode } from "../src/engine/totp.js";
import { setUsername } from "../src/engine/username.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { post, tokenFromMail } from "./helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleClaims,
  googleSignIn,
  tokenEndpoint,
} from "./social-helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

const SUBJECT = "Security notice for your api.example.com account";
const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
const NEW = "a new long password";

afterEach(() => {
  vi.restoreAllMocks();
});

const notices = (mail: MailMessage[]) => mail.filter((m) => m.subject === SUBJECT);

/** Each notice that went out: the address, the first line, and the IP line or null. */
const sentNotices = (mail: MailMessage[]) =>
  notices(mail).map((m) => {
    const lines = m.text.split("\n");
    return [m.to, lines[0], lines.find((l) => l.startsWith("IP address:")) ?? null];
  });

async function change(auth: Auth) {
  const s = await verifiedSession(auth);
  return changePassword(auth.config, {
    session: s,
    currentPassword: PASSWORD,
    newPassword: NEW,
    ip: "7.7.7.7",
    userAgent: "Agent/7",
  });
}

/**
 * An engine whose notice builder records each input and answers the default
 * mail, so a test reads both the input and the sent mail.
 */
function recorded(extra: Partial<AuthConfig> = {}) {
  const seen: NoticeMailInput[] = [];
  const auth = totpAuth({
    passkey: RP,
    ...extra,
    account: {
      notices: {
        mail: (i) => {
          seen.push(i);
          return defaultNoticeMail(i);
        },
      },
    },
  });
  /** The inputs since `from`: the event, the address, the IP, and the user agent. */
  const since = (from: number) =>
    seen.slice(from).map((i) => [i.event, i.email, i.ip, i.userAgent]);
  return { auth, seen, since };
}

/** A registered passkey of the session's user, by the engine's own ceremony. */
async function addPasskey(auth: Auth, session: Awaited<ReturnType<typeof verifiedSession>>) {
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
  const options = await passkeyRegistrationOptions(auth.config, { user: session.user });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(auth.config, {
    user: session.user,
    response: await soft.register(
      options.value.challenge,
      new TextEncoder().encode(session.user.id),
    ),
  });
  if (!added.ok) throw new Error(added.code);
  return { soft, id: added.value.id };
}

/** A sign-in assertion of `soft`: the passkey method's proof that the person holds it now. */
async function signInAssertion(auth: Auth, soft: SoftAuthenticator) {
  const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
  if (!options.ok) throw new Error(options.code);
  return soft.authenticate(options.value.challenge);
}

async function resetByLink(auth: Auth, mail: MailMessage[], ip: string | null, ua: string | null) {
  await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
  return resetPassword(auth.config, {
    token: tokenFromMail(mail.findLast((m) => m.subject.startsWith("Reset"))?.text ?? ""),
    password: "a reset long password",
    ip,
    userAgent: ua,
  });
}

describe("the notice mail (plan 12a, ASVS 5.0.0 6.3.7)", () => {
  it("sends one notice to the address after a password change, with the time and the IP, and no password", async () => {
    const auth = totpAuth();
    expect((await change(auth)).ok).toBe(true);
    const sent = notices(auth.mail);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(EMAIL);
    expect(sent[0]?.text).toContain("Your password was changed.");
    expect(sent[0]?.text).toContain(`Time: ${auth.clock.now().toISOString()}.`);
    expect(sent[0]?.text).toContain("IP address: 7.7.7.7.");
    expect(sent[0]?.text).not.toContain(NEW);
  });

  it("sends a notice after a reset, a passkey add and remove, and a factor enable and disable", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, secret } = await enrolled(auth);
    // The factor is on, so the reset answers the challenge. The notice goes all the same.
    const reset = await resetByLink(auth, auth.mail, null, null);
    expect(reset.ok && "twoFactor" in reset.value).toBe(true);
    const { id } = await addPasskey(auth, session);
    expect((await deletePasskey(auth.config, { user: session.user, id })).ok).toBe(true);
    auth.clock.advance(30_000);
    expect(
      (
        await disableTotpWithCode(auth.config, {
          user: session.user,
          code: await codeNow(auth, secret),
        })
      ).ok,
    ).toBe(true);
    expect(notices(auth.mail).map((m) => m.text.split("\n")[0])).toEqual([
      "A second factor was turned on for your account.",
      "Your password was reset.",
      "A passkey was added to your account.",
      "A passkey was removed from your account.",
      "A second factor was turned off for your account.",
    ]);
  });

  it("sends no notice with notices: false", async () => {
    const auth = totpAuth({ account: { notices: false } });
    expect((await change(auth)).ok).toBe(true);
    expect(notices(auth.mail)).toEqual([]);
  });

  it("sends to the address whatever the builder answers", async () => {
    const auth = totpAuth({
      account: { notices: { mail: (i) => ({ ...defaultNoticeMail(i), to: "x@example.com" }) } },
    });
    expect((await change(auth)).ok).toBe(true);
    expect(notices(auth.mail).map((m) => m.to)).toEqual([EMAIL]);
  });

  it("keeps the change and writes one line when the notice fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      account: {
        notices: {
          mail: () => {
            throw new TypeError("no template");
          },
        },
      },
    });
    expect((await change(auth)).ok).toBe(true);
    expect(log.mock.calls).toContainEqual([
      "authtempo: notice mail failed",
      "password_changed",
      "TypeError",
    ]);
    const signIn = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: NEW,
      ip: null,
      userAgent: null,
    });
    expect(signIn.ok && "token" in signIn.value).toBe(true);
  });

  it("refuses an unknown key of account.notices", () => {
    expect(() => totpAuth({ account: { notices: { subject: "x" } as never } })).toThrow(
      "account.notices.subject is not an option; core has mail",
    );
  });
});

describe("one notice per change, after the commit, per path (plan 12a)", () => {
  it("password change: the engine passes the caller's IP and user agent", async () => {
    const { auth, since } = recorded();
    expect((await change(auth)).ok).toBe(true);
    expect(since(0)).toEqual([["password_changed", EMAIL, "7.7.7.7", "Agent/7"]]);
    expect(sentNotices(auth.mail)).toEqual([
      [EMAIL, "Your password was changed.", "IP address: 7.7.7.7."],
    ]);
  });

  it("password change: the route passes the client IP and the user agent header", async () => {
    const { auth, since } = recorded();
    const s = await verifiedSession(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      post(
        "/auth/password/change",
        { currentPassword: PASSWORD, newPassword: NEW },
        {
          authorization: `Bearer ${s.token}`,
          "cf-connecting-ip": "6.6.6.6",
          "user-agent": "Route/6",
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(since(0)).toEqual([["password_changed", EMAIL, "6.6.6.6", "Route/6"]]);
  });

  it("password change: a first password of a magic-link user sends the notice too", async () => {
    const { auth, since } = recorded();
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    const signedIn = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!signedIn.ok || !("token" in signedIn.value)) throw new Error("no session");
    const session = await resolveSession(auth.config, signedIn.value.token);
    if (!session) throw new Error("no session");
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    const first = await changePassword(auth.config, { session, newPassword: NEW });
    expect(first.ok).toBe(true);
    expect(since(0)).toEqual([["password_changed", EMAIL, null, null]]);
  });

  it("password change: a refused change sends no notice", async () => {
    const { auth, since } = recorded();
    const s = await verifiedSession(auth);
    const refused = await changePassword(auth.config, {
      session: s,
      currentPassword: "not the password",
      newPassword: NEW,
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(since(0)).toEqual([]);
    expect(notices(auth.mail)).toEqual([]);
  });

  it("reset by link: one notice with the reset's IP and user agent", async () => {
    const { auth, since } = recorded();
    await verifiedSession(auth);
    const reset = await resetByLink(auth, auth.mail, "5.5.5.5", "Reset/5");
    expect(reset.ok && "token" in reset.value).toBe(true);
    expect(since(0)).toEqual([["password_reset", EMAIL, "5.5.5.5", "Reset/5"]]);
    expect(sentNotices(auth.mail)).toEqual([
      [EMAIL, "Your password was reset.", "IP address: 5.5.5.5."],
    ]);
  });

  it("reset by link: a refused reset sends no notice", async () => {
    const { auth, since } = recorded();
    await verifiedSession(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const refused = await resetPassword(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      password: "short",
      ip: null,
      userAgent: null,
    });
    expect(refused.ok).toBe(false);
    expect(since(0)).toEqual([]);
  });

  it("reset by code: one notice with the reset's IP and user agent", async () => {
    const { auth, since } = recorded();
    await verifiedSession(auth);
    expect((await requestResetOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const reset = await resetPasswordWithOtp(auth.config, {
      email: EMAIL,
      code,
      password: "a reset long password",
      ip: "4.4.4.4",
      userAgent: "Code/4",
    });
    expect(reset.ok && "token" in reset.value).toBe(true);
    expect(since(0)).toEqual([["password_reset", EMAIL, "4.4.4.4", "Code/4"]]);
  });

  it("passkey add: one notice", async () => {
    const { auth, since } = recorded();
    const session = await verifiedSession(auth);
    await addPasskey(auth, session);
    expect(since(0)).toEqual([["passkey_added", EMAIL, null, null]]);
    expect(sentNotices(auth.mail)).toEqual([[EMAIL, "A passkey was added to your account.", null]]);
  });

  it("passkey remove: one notice, and none for a delete that finds no passkey", async () => {
    const { auth, seen, since } = recorded();
    const session = await verifiedSession(auth);
    const { id } = await addPasskey(auth, session);
    const from = seen.length;
    const none = await deletePasskey(auth.config, { user: session.user, id: "pk_unknown" });
    expect(none).toMatchObject({ ok: false, code: "not_found" });
    expect(since(from)).toEqual([]);
    expect((await deletePasskey(auth.config, { user: session.user, id })).ok).toBe(true);
    expect(since(from)).toEqual([["passkey_removed", EMAIL, null, null]]);
  });

  it("TOTP enable: one notice", async () => {
    const { auth, since } = recorded();
    await enrolled(auth);
    expect(since(0)).toEqual([["factor_enabled", EMAIL, null, null]]);
    expect(sentNotices(auth.mail)).toEqual([
      [EMAIL, "A second factor was turned on for your account.", null],
    ]);
  });

  it("TOTP disable with a code: one notice, and none for a wrong code", async () => {
    const { auth, seen, since } = recorded();
    const { user, secret } = await enrolled(auth);
    const from = seen.length;
    const right = await codeNow(auth, secret);
    const wrong = await disableTotpWithCode(auth.config, { user, code: wrongFor(right) });
    expect(wrong).toMatchObject({ ok: false, code: "invalid_code" });
    expect(since(from)).toEqual([]);
    expect((await disableTotpWithCode(auth.config, { user, code: right })).ok).toBe(true);
    expect(since(from)).toEqual([["factor_disabled", EMAIL, null, null]]);
  });

  it("TOTP disable in process: one notice to the stored address, and none when the factor is off", async () => {
    const { auth, seen, since } = recorded();
    const { user } = await enrolled(auth);
    const from = seen.length;
    expect((await disableTotp(auth.config, { userId: user.id })).ok).toBe(true);
    expect(since(from)).toEqual([["factor_disabled", EMAIL, null, null]]);
    const again = await disableTotp(auth.config, { userId: user.id });
    expect(again).toMatchObject({ ok: false, code: "totp_not_enabled" });
    expect(since(from)).toHaveLength(1);
  });

  it("passkey method enable: one notice, and none for a wrong password", async () => {
    const { auth, seen, since } = recorded();
    const session = await verifiedSession(auth);
    const { soft } = await addPasskey(auth, session);
    const from = seen.length;
    const wrong = await enablePasskeyMethod(auth.config, {
      session,
      password: "not the password",
      response: await signInAssertion(auth, soft),
    });
    expect(wrong.ok).toBe(false);
    expect(since(from)).toEqual([]);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    expect(on.ok).toBe(true);
    expect(since(from)).toEqual([["factor_enabled", EMAIL, null, null]]);
  });

  it("email method enable and disable: one notice each", async () => {
    const { auth, since } = recorded();
    const session = await verifiedSession(auth);
    expect((await enableEmailMethod(auth.config, { session, password: PASSWORD })).ok).toBe(true);
    expect(since(0)).toEqual([["factor_enabled", EMAIL, null, null]]);
    const off = await disableMethod(auth.config, {
      user: session.user,
      method: "email",
      password: PASSWORD,
    });
    expect(off.ok).toBe(true);
    expect(since(0)).toEqual([
      ["factor_enabled", EMAIL, null, null],
      ["factor_disabled", EMAIL, null, null],
    ]);
  });

  it("method disable: none for a method that is not on", async () => {
    const { auth, since } = recorded();
    const session = await verifiedSession(auth);
    const off = await disableMethod(auth.config, {
      user: session.user,
      method: "email",
      password: PASSWORD,
    });
    expect(off).toMatchObject({ ok: false, code: "totp_not_enabled" });
    expect(since(0)).toEqual([]);
  });

  it("gives the builder the app name and the clock's time", async () => {
    const { auth, seen } = recorded();
    expect((await change(auth)).ok).toBe(true);
    expect(seen).toEqual([
      {
        event: "password_changed",
        email: EMAIL,
        appName: "api.example.com",
        at: new Date("2026-01-01T00:00:00.000Z"),
        ip: "7.7.7.7",
        userAgent: "Agent/7",
      },
    ]);
  });
});

describe("a notice that fails keeps the change (plan 12a)", () => {
  it("logs a throw of the mail port with the error name only, and the reset keeps its session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // The port fills the array that the helpers read, and throws on a notice.
    let sent: MailMessage[] = [];
    const auth = totpAuth({
      mail: {
        send: async (m) => {
          if (m.subject === SUBJECT) throw new RangeError(`smtp refused ${m.to}`);
          sent.push(m);
        },
      },
    });
    sent = auth.mail;
    await verifiedSession(auth);
    const reset = await resetByLink(auth, sent, "5.5.5.5", null);
    if (!reset.ok || !("token" in reset.value)) throw new Error("the reset failed");
    expect(await resolveSession(auth.config, reset.value.token)).not.toBeNull();
    expect(log.mock.calls).toEqual([
      ["authtempo: notice mail failed", "password_reset", "RangeError"],
    ]);
  });

  it("logs Error for an error name that is not a plain class name, so no address reaches the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      account: {
        notices: {
          mail: (i) => {
            const e = new Error(`no template for ${i.email}`);
            e.name = `Template ${i.email}`;
            throw e;
          },
        },
      },
    });
    expect((await change(auth)).ok).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: notice mail failed", "password_changed", "Error"],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(EMAIL);
  });

  it("logs the type of a thrown value that is no Error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      account: {
        notices: {
          mail: (i) => {
            throw `no template for ${i.email}`;
          },
        },
      },
    });
    expect((await change(auth)).ok).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: notice mail failed", "password_changed", "string"],
    ]);
  });

  it("answers success on every path when each notice throws, with one line per notice", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      passkey: RP,
      account: {
        notices: {
          mail: () => {
            throw new TypeError("no template");
          },
        },
      },
    });
    const { session, secret, user } = await enrolled(auth);
    const changed = await changePassword(auth.config, {
      session,
      currentPassword: PASSWORD,
      newPassword: NEW,
    });
    expect(changed.ok).toBe(true);
    expect((await enableEmailMethod(auth.config, { session, password: NEW })).ok).toBe(true);
    expect((await disableMethod(auth.config, { user, method: "email", password: NEW })).ok).toBe(
      true,
    );
    const { id } = await addPasskey(auth, session);
    expect((await deletePasskey(auth.config, { user, id })).ok).toBe(true);
    auth.clock.advance(30_000);
    expect(
      (await disableTotpWithCode(auth.config, { user, code: await codeNow(auth, secret) })).ok,
    ).toBe(true);
    // The factor is off now, so the reset opens a session.
    const reset = await resetByLink(auth, auth.mail, null, null);
    expect(reset.ok && "token" in reset.value).toBe(true);
    expect(log.mock.calls.map((c) => c[1])).toEqual([
      "factor_enabled",
      "password_changed",
      "factor_enabled",
      "factor_disabled",
      "passkey_added",
      "passkey_removed",
      "factor_disabled",
      "password_reset",
    ]);
    expect(log.mock.calls.every((c) => c.length === 3 && c[2] === "TypeError")).toBe(true);
  });
});

describe("account.notices (plan 12a)", () => {
  it("off: no notice on any path, and the reset mail and the reauth code still go", async () => {
    const auth = totpAuth({ passkey: RP, account: { notices: false } });
    const { session, secret, user } = await enrolled(auth);
    expect((await requestReauthCode(auth.config, { session })).ok).toBe(true);
    const reset = await resetByLink(auth, auth.mail, null, null);
    expect(reset.ok).toBe(true);
    const { id } = await addPasskey(auth, session);
    expect((await deletePasskey(auth.config, { user, id })).ok).toBe(true);
    auth.clock.advance(30_000);
    expect(
      (await disableTotpWithCode(auth.config, { user, code: await codeNow(auth, secret) })).ok,
    ).toBe(true);
    expect(notices(auth.mail)).toEqual([]);
    expect(auth.mail.map((m) => m.subject)).toEqual([
      "Confirm your email for api.example.com",
      "Your confirmation code for api.example.com",
      "Reset your password for api.example.com",
    ]);
  });

  it("a notice builder leaves the proof mails on the default text", async () => {
    const auth = totpAuth({
      account: { notices: { mail: (i) => ({ ...defaultNoticeMail(i), subject: "app notice" }) } },
    });
    const s = await verifiedSession(auth);
    expect((await requestReauthCode(auth.config, { session: s })).ok).toBe(true);
    const changed = await changePassword(auth.config, {
      session: s,
      currentPassword: PASSWORD,
      newPassword: NEW,
    });
    expect(changed.ok).toBe(true);
    expect(auth.mail.slice(1).map((m) => m.subject)).toEqual([
      "Your confirmation code for api.example.com",
      "app notice",
    ]);
  });

  it("a proof mail builder leaves the notices on the default text", async () => {
    const auth = totpAuth({
      account: { mail: (i) => ({ to: i.email, subject: "app proof", text: "x" }) },
    });
    expect((await change(auth)).ok).toBe(true);
    expect(sentNotices(auth.mail)).toEqual([
      [EMAIL, "Your password was changed.", "IP address: 7.7.7.7."],
    ]);
  });

  it("is on with the default text when absent, empty, or with mail undefined", async () => {
    const forms: (AccountConfig | undefined)[] = [
      undefined,
      {},
      { notices: {} },
      // A JavaScript app can write an undefined field; the type does not allow it.
      { notices: { mail: undefined } as never },
    ];
    for (const account of forms) {
      const auth = totpAuth(account === undefined ? {} : { account });
      expect((await change(auth)).ok).toBe(true);
      expect(sentNotices(auth.mail)).toEqual([
        [EMAIL, "Your password was changed.", "IP address: 7.7.7.7."],
      ]);
    }
  });

  it("refuses an unknown key, a mail that is no function, and a value that is no object or false", () => {
    expect(() => totpAuth({ account: { notices: { subject: "x" } as never } })).toThrow(
      new ConfigError("account.notices.subject is not an option; core has mail"),
    );
    expect(() => totpAuth({ account: { notices: { mail: "x" } as never } })).toThrow(
      new ConfigError("account.notices.mail must be a function"),
    );
    for (const notices of [true, "x", [], null, 1])
      expect(() => totpAuth({ account: { notices: notices as never } })).toThrow(
        new ConfigError("account.notices must be an object or false"),
      );
  });
});

describe("defaultNoticeMail (plan 12a)", () => {
  const at = new Date("2026-03-04T05:06:07.000Z");
  const base = { email: "a@example.com", appName: "Example", at, ip: "1.2.3.4", userAgent: "UA" };
  const RESET_TAIL = "If this was not you, reset your password and end your other sessions.";
  const SUPPORT_TAIL = "If you did not make this change, contact the support of Example at once.";

  it.each([
    ["password_changed", "Your password was changed.", RESET_TAIL],
    ["password_reset", "Your password was reset.", RESET_TAIL],
    ["email_changed", "The email address of your account was changed.", SUPPORT_TAIL],
    ["factor_enabled", "A second factor was turned on for your account.", RESET_TAIL],
    ["factor_disabled", "A second factor was turned off for your account.", RESET_TAIL],
    ["passkey_added", "A passkey was added to your account.", RESET_TAIL],
    ["passkey_removed", "A passkey was removed from your account.", RESET_TAIL],
    ["identity_linked", "A sign-in provider was linked to your account.", RESET_TAIL],
    ["identity_unlinked", "A sign-in provider was removed from your account.", RESET_TAIL],
    ["account_deleted", "Your account was deleted.", SUPPORT_TAIL],
  ] as const)("writes the %s notice", (event, first, tail) => {
    expect(defaultNoticeMail({ ...base, event })).toEqual({
      to: "a@example.com",
      subject: "Security notice for your Example account",
      text: [first, "Time: 2026-03-04T05:06:07.000Z.", "IP address: 1.2.3.4.", tail].join("\n"),
    });
  });

  it("names the new address and the provider, and leaves out an unknown IP", () => {
    expect(
      defaultNoticeMail({ ...base, event: "email_changed", ip: null, newEmail: "b@example.com" })
        .text,
    ).toBe(
      [
        "The email address of your account was changed.",
        "The new address is b@example.com.",
        "Time: 2026-03-04T05:06:07.000Z.",
        SUPPORT_TAIL,
      ].join("\n"),
    );
    expect(
      defaultNoticeMail({ ...base, event: "identity_linked", ip: null, provider: "github" }).text,
    ).toBe(
      [
        "A sign-in provider was linked to your account.",
        "The provider is github.",
        "Time: 2026-03-04T05:06:07.000Z.",
        RESET_TAIL,
      ].join("\n"),
    );
  });

  it("holds no user agent, no link, and no code", () => {
    const text = defaultNoticeMail({
      ...base,
      event: "password_reset",
      userAgent: "Secret/9",
    }).text;
    expect(text).not.toContain("Secret/9");
    expect(text).not.toMatch(/https?:|token=|\b\d{6}\b/);
  });
});

/**
 * The engine's own store and mail port, wrapped in place (plan 12a review M2).
 * The store counts open transactions and can fail the next commit: the
 * callback runs, then a throw rolls it back. The port records the depth at
 * each send.
 */
function tracked() {
  const st = { depth: 0, failCommit: false };
  const sent: { m: MailMessage; depth: number }[] = [];
  // Google too, for the unlink path (plan 12a Task 9).
  const jwtTokens: Record<string, FakeIdToken> = {};
  const auth = totpAuth({
    passkey: RP,
    social: { google: GOOGLE, fetch: tokenEndpoint("idtok-default").fetchFn },
    jwt: fakeJwt(jwtTokens),
    username: {},
  });
  const store = auth.config.storage as StorageAdapter;
  const origTx = store.transaction.bind(store);
  (store as { transaction: StorageAdapter["transaction"] }).transaction = (async <R>(
    fn: (tx: StorageAdapter) => Promise<R>,
  ) => {
    st.depth++;
    try {
      return await origTx(async (tx) => {
        const r = await fn(tx);
        if (st.failCommit) throw new Error("probe: the commit failed");
        return r;
      });
    } finally {
      st.depth--;
    }
  }) as StorageAdapter["transaction"];
  const port = auth.config.mail as { send: (m: MailMessage) => Promise<void> };
  const orig = port.send;
  port.send = async (m) => {
    sent.push({ m, depth: st.depth });
    await orig(m);
  };
  const mail = () => sent.map((x) => x.m);
  const noticesSent = () => sent.filter((x) => x.m.subject === SUBJECT);
  return { auth, st, mail, noticesSent, jwtTokens };
}

type Tracked = ReturnType<typeof tracked>;
/** Each path: `run` builds the state and answers `act`, the change. */
const PATHS: {
  name: string;
  run: (t: Tracked) => Promise<{ act: () => Promise<{ ok: boolean }> }>;
}[] = [
  // Plan 12i Task 2: the username is a way in.
  {
    name: "username set",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      return {
        act: () =>
          setUsername(auth.config, { session: s, username: "Ada", ip: null, userAgent: null }),
      };
    },
  },
  {
    name: "password change",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      return {
        act: () =>
          changePassword(auth.config, { session: s, currentPassword: PASSWORD, newPassword: NEW }),
      };
    },
  },
  {
    name: "reset link",
    run: async ({ auth, mail }) => {
      await verifiedSession(auth);
      await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
      const token = tokenFromMail(
        mail().findLast((m) => m.subject.startsWith("Reset"))?.text ?? "",
      );
      return {
        act: () =>
          resetPassword(auth.config, {
            token,
            password: "a reset long password",
            ip: null,
            userAgent: null,
          }),
      };
    },
  },
  {
    name: "reset code",
    run: async ({ auth, mail }) => {
      await verifiedSession(auth);
      await requestResetOtp(auth.config, { email: EMAIL, ip: null });
      const code = /\b(\d{6})\b/.exec(mail().at(-1)?.text ?? "")?.[1] ?? "";
      return {
        act: () =>
          resetPasswordWithOtp(auth.config, {
            email: EMAIL,
            code,
            password: "a reset long password",
            ip: null,
            userAgent: null,
          }),
      };
    },
  },
  {
    name: "passkey remove",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      const { id } = await addPasskey(auth, s);
      return { act: () => deletePasskey(auth.config, { user: s.user, id }) };
    },
  },
  {
    name: "TOTP disable with a code",
    run: async ({ auth }) => {
      const { user, secret } = await enrolled(auth);
      const code = await codeNow(auth, secret);
      return { act: () => disableTotpWithCode(auth.config, { user, code }) };
    },
  },
  {
    name: "TOTP disable in process",
    run: async ({ auth }) => {
      const { user } = await enrolled(auth);
      return { act: () => disableTotp(auth.config, { userId: user.id }) };
    },
  },
  {
    name: "email method enable",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      return { act: () => enableEmailMethod(auth.config, { session: s, password: PASSWORD }) };
    },
  },
  {
    name: "email method disable",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      await enableEmailMethod(auth.config, { session: s, password: PASSWORD });
      return {
        act: () =>
          disableMethod(auth.config, { user: s.user, method: "email", password: PASSWORD }),
      };
    },
  },
  {
    name: "change of address by link",
    run: async ({ auth, mail }) => {
      const s = await verifiedSession(auth);
      await requestEmailChange(auth.config, { session: s, newEmail: "ada.new@example.com" });
      const token = tokenFromMail(mail().at(-1)?.text ?? "");
      return { act: () => confirmEmailChange(auth.config, { token, ip: null, userAgent: null }) };
    },
  },
  {
    name: "change of address by code",
    run: async ({ auth, mail }) => {
      const s = await verifiedSession(auth);
      await requestEmailChange(auth.config, {
        session: s,
        newEmail: "ada.new@example.com",
        method: "code",
      });
      const code = /\b(\d{6})\b/.exec(mail().at(-1)?.text ?? "")?.[1] ?? "";
      return {
        act: () => verifyEmailChange(auth.config, { session: s, code, ip: null, userAgent: null }),
      };
    },
  },
  {
    name: "identity unlink",
    run: async ({ auth, jwtTokens }) => {
      await verifiedSession(auth);
      // A verified address that a user holds: the Google sign-in links Google.
      const s = await googleSignIn(auth, jwtTokens);
      const google = await auth.storage.findMany("identity", [
        { field: "userId", op: "eq", value: s.user.id },
        { field: "provider", op: "eq", value: "google" },
      ]);
      const id = google[0]?.id ?? "";
      return {
        act: () => unlinkIdentity(auth.config, { session: s, id, ip: null, userAgent: null }),
      };
    },
  },
  {
    name: "identity link",
    run: async ({ auth, jwtTokens }) => {
      const s = await verifiedSession(auth);
      const started = await startLink(auth.config, { provider: "google", session: s, ip: null });
      if (!started.ok) throw new Error(started.code);
      const url = new URL(started.value.location);
      jwtTokens["idtok-default"] = googleClaims(url.searchParams.get("nonce") ?? "", {});
      return {
        act: () =>
          completeSocial(auth.config, {
            provider: "google",
            state: url.searchParams.get("state"),
            code: "c",
            error: null,
            bindToken: started.value.bindToken,
            sessionToken: s.token,
            ip: null,
            userAgent: null,
          }),
      };
    },
  },
  {
    name: "account delete",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      return { act: () => deleteAccount(auth.config, { session: s, ip: null, userAgent: null }) };
    },
  },
  {
    name: "account delete confirm",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      // The same store and mail port with the mailed confirm on (plan 12a Task 20).
      const on = {
        ...auth.config,
        account: { ...auth.config.account, deleteConfirm: { ttlMinutes: 60 } },
      };
      const asked = await requestAccountDelete(on, { session: s, ip: null, userAgent: null });
      if (!asked.ok) throw new Error(asked.code);
      const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
      return {
        act: () => confirmAccountDelete(on, { session: s, token, ip: null, userAgent: null }),
      };
    },
  },
  {
    name: "passkey method enable",
    run: async ({ auth }) => {
      const s = await verifiedSession(auth);
      const { soft } = await addPasskey(auth, s);
      const response = await signInAssertion(auth, soft);
      return {
        act: () => enablePasskeyMethod(auth.config, { session: s, password: PASSWORD, response }),
      };
    },
  },
];

describe("the notice goes after the commit (plan 12a review M1, M2)", () => {
  it("sends every notice outside a transaction, on every path", async () => {
    const t = tracked();
    const s = await enrolled(t.auth);
    await addPasskey(t.auth, s.session);
    for (const p of PATHS) {
      const u = tracked();
      const { act } = await p.run(u);
      const before = u.noticesSent().length;
      expect((await act()).ok, p.name).toBe(true);
      expect(u.noticesSent().slice(before), p.name).toHaveLength(1);
      expect(
        u.noticesSent().every((n) => n.depth === 0),
        p.name,
      ).toBe(true);
    }
    // The TOTP enable and the passkey add.
    expect(t.noticesSent().map((n) => n.depth)).toEqual([0, 0]);
  });

  for (const p of PATHS)
    it(`sends no notice when the commit fails: ${p.name}`, async () => {
      const u = tracked();
      const { act } = await p.run(u);
      const before = u.noticesSent().length;
      u.st.failCommit = true;
      const r = await act().then(
        (x) => ({ answered: x }),
        (e: unknown) => ({ threw: String(e) }),
      );
      u.st.failCommit = false;
      expect(r, p.name).toEqual({ threw: "Error: probe: the commit failed" });
      expect(u.noticesSent().length, p.name).toBe(before);
    });

  for (const name of ["account delete", "account delete confirm"])
    it(`keeps the verification rows when the commit fails, and deletes them after the commit: ${name}`, async () => {
      // account-delete.ts deletes the user's verification rows after the
      // commit (plan 12a fix wave): a rolled-back delete keeps every live
      // proof, and the delete runs outside the transaction (a reset holds its
      // link row before the user row, so a delete inside could deadlock on Postgres).
      const p = PATHS.find((x) => x.name === name);
      if (!p) throw new Error(`no path ${name}`);
      const u = tracked();
      const { act } = await p.run(u);
      expect((await requestMagicLink(u.auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
      const store = u.auth.config.storage as StorageAdapter;
      const deletes: { where: unknown; depth: number }[] = [];
      const orig = store.delete.bind(store);
      (store as { delete: StorageAdapter["delete"] }).delete = (async (model, where) => {
        if (model === "verification") deletes.push({ where, depth: u.st.depth });
        return orig(model, where);
      }) as StorageAdapter["delete"];
      const rows = async () =>
        (await store.findMany("verification", [])).sort((a, b) => a.id.localeCompare(b.id));
      const before = await rows();
      expect(before.some((r) => r.identifier === EMAIL)).toBe(true);
      u.st.failCommit = true;
      await expect(act()).rejects.toThrow("probe: the commit failed");
      u.st.failCommit = false;
      expect(await rows()).toEqual(before);
      expect(deletes).toEqual([]);
      // The control: the same call commits, then one delete outside any transaction.
      expect((await act()).ok).toBe(true);
      expect((await rows()).filter((r) => r.identifier === EMAIL)).toEqual([]);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.depth).toBe(0);
    });

  it("sends no notice for an enable of a method that is already on", async () => {
    const u = tracked();
    const s = await verifiedSession(u.auth);
    expect((await enableEmailMethod(u.auth.config, { session: s, password: PASSWORD })).ok).toBe(
      true,
    );
    const again = await enableEmailMethod(u.auth.config, { session: s, password: PASSWORD });
    expect(again).toEqual({ ok: true, value: { methods: ["email"], backupCodes: [] } });
    const { soft } = await addPasskey(u.auth, s);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await enablePasskeyMethod(u.auth.config, {
            session: s,
            password: PASSWORD,
            response: await signInAssertion(u.auth, soft),
          })
        ).ok,
      ).toBe(true);
    expect(u.noticesSent().map((n) => n.m.text.split("\n")[0])).toEqual([
      "A second factor was turned on for your account.",
      "A passkey was added to your account.",
      "A second factor was turned on for your account.",
    ]);
  });

  it("sends no passkey_removed for the refused delete of the last passkey of the passkey method", async () => {
    const u = tracked();
    const s = await verifiedSession(u.auth);
    const { soft, id } = await addPasskey(u.auth, s);
    await enablePasskeyMethod(u.auth.config, {
      session: s,
      password: PASSWORD,
      response: await signInAssertion(u.auth, soft),
    });
    const before = u.noticesSent().length;
    const r = await deletePasskey(u.auth.config, { user: s.user, id });
    expect(r).toMatchObject({ ok: false, code: "second_factor_last_method" });
    expect(u.noticesSent().length).toBe(before);
  });
});

describe("the notice and app data (plan 12a review L1, L2)", () => {
  it("keeps the change and logs Error when the builder's error has a name getter that throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = totpAuth({
      account: {
        notices: {
          mail: (i) => {
            const e = new Error("no template");
            Object.defineProperty(e, "name", {
              get() {
                throw new TypeError(`getter ${i.email}`);
              },
            });
            throw e;
          },
        },
      },
    });
    expect(await change(auth)).toEqual({ ok: true, value: { ok: true } });
    expect(log.mock.calls).toEqual([
      ["authtempo: notice mail failed", "password_changed", "Error"],
    ]);
  });

  it("prints only an IP literal; a crafted client IP header gives the line of an unknown IP", async () => {
    const { auth, since } = recorded();
    const s = await verifiedSession(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const crafted = "203.0.113.9 (your own laptop; no action is needed)";
    const res = await handle(
      post(
        "/auth/password/change",
        { currentPassword: PASSWORD, newPassword: NEW },
        { authorization: `Bearer ${s.token}`, "cf-connecting-ip": crafted },
      ),
    );
    expect(res.status).toBe(200);
    // The builder gets the value as read; the default text leaves it out.
    expect(since(0)).toEqual([["password_changed", EMAIL, crafted, null]]);
    expect(sentNotices(auth.mail)).toEqual([[EMAIL, "Your password was changed.", null]]);
  });

  it.each([
    ["192.0.2.1", true],
    ["2001:db8::1", true],
    ["::ffff:192.0.2.1", true],
    ["192.0.2.1 hi", false],
    ["256.0.0.1", false],
    ["fe80::1%eth0", false],
    ["[2001:db8::1]", false],
    ["unknown", false],
    // Hex and colons only, so the IPv6 parse decides (review R3-L1 of Task 6).
    ["1:2:3", false],
    [":::", false],
    ["1234:".repeat(40), false],
  ])("the default text prints the IP %s: %s", (ip, printed) => {
    const text = defaultNoticeMail({
      event: "password_changed",
      email: "a@example.com",
      appName: "Example",
      at: new Date("2026-03-04T05:06:07.000Z"),
      ip,
      userAgent: null,
    }).text;
    expect(text.includes(`IP address: ${ip}.`)).toBe(printed);
    expect(text.includes("IP address:")).toBe(printed);
  });
});
