import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { SESSION_VIA, type SessionVia } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { operatorApi } from "../src/engine/operator/index.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import {
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { addPhone, requestPhone, verifyAddPhone, verifyPhone } from "../src/engine/phone.js";
import { enableEmailMethod } from "../src/engine/second-factor-methods.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { addDomain, verifyDomain } from "../src/engine/sso/domains.js";
import { completeSsoOidc, startSso } from "../src/engine/sso/oidc.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { confirmUserInvite } from "../src/engine/user-invite.js";
import { randomBase64Url, sha256Base64Url } from "../src/primitives/crypto.js";
import type { Result } from "../src/result.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { sessionFor, tokenFromMail } from "./helpers.js";
import { operatorAuth } from "./operator-helpers.js";
import { recordNextTransaction, signUpAndVerify } from "./password-helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt, GOOGLE, tokenEndpoint } from "./social-helpers.js";
import { fakeDns, SSO_APP, seedOrganization } from "./sso/helpers.js";
import { codeNow, enrolled, PASSWORD } from "./totp-helpers.js";

const EMAIL = "ada@example.com";
const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
const APP = { kind: "app", name: "support-tool" } as const;
const WRONG = "a wrong password here";

/**
 * The engine view of the doors test: the operator tools, every sign-in
 * method, and a recorder of `session.beforeCreate`. The hook count shows
 * that the ban stops a flow in `prepareSession`, before the hook.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const tokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-default");
  const before: SessionVia[] = [];
  // The fake DNS ports and the fake IdP of the SSO door (plan 12d Task 5).
  const txt: Record<string, string[]> = {};
  const idp = fakeFetch((call) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  // The phone door (plan 12i Task 5) reads its codes from this port.
  const sms = createRecordingSms();
  const auth = await operatorAuth({
    phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
    social: { google: GOOGLE, fetch: fetchFn },
    sso: { oidc: true, fetch: idp.fetchFn, dns: [fakeDns("a", txt), fakeDns("b", txt)] },
    jwt: fakeJwt(tokens),
    passkey: RP,
    handoff: { schemes: ["consumera://"] },
    hooks: {
      session: {
        beforeCreate: (e) => {
          before.push(e.via);
        },
      },
    },
    ...extra,
  });
  return { auth, tokens, before, txt, sms };
}

type World = Awaited<ReturnType<typeof world>>;
type Answer = Result<unknown>;

/** The user of the address, read from storage. */
async function userOf(w: World, email = EMAIL): Promise<UserRow> {
  const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  return user;
}

async function ban(w: World): Promise<void> {
  const user = await userOf(w);
  const r = await operatorApi(w.auth.config).users.ban({
    actor: APP,
    userId: user.id,
    reason: "Abuse report 1",
    ip: null,
    userAgent: null,
  });
  if (!r.ok) throw new Error(r.code);
}

const password = (w: World, secret = PASSWORD) =>
  passwordSignIn(w.auth.config, { email: EMAIL, password: secret, ip: null, userAgent: null });

async function magicLink(w: World): Promise<Answer> {
  const sent = await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
  if (!sent.ok) throw new Error(sent.code);
  const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
  return verifyMagicLink(w.auth.config, { token, ip: null, userAgent: null });
}

async function emailCode(w: World): Promise<Answer> {
  const sent = await requestEmailOtp(w.auth.config, { email: EMAIL, ip: null });
  if (!sent.ok) throw new Error(sent.code);
  const code = /\b(\d{6})\b/.exec(w.auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
  return verifyEmailOtp(w.auth.config, { email: EMAIL, code, ip: null, userAgent: null });
}

async function social(w: World): Promise<Answer> {
  const started = await startSocial(w.auth.config, { provider: "google", next: "/", ip: null });
  if (!started.ok) throw new Error(started.code);
  const url = new URL(started.value.location);
  w.tokens["idtok-default"] = {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: {
      sub: "g-1",
      email: EMAIL,
      email_verified: true,
      nonce: url.searchParams.get("nonce") ?? "",
    },
  };
  return completeSocial(w.auth.config, {
    provider: "google",
    state: url.searchParams.get("state") ?? "",
    code: "code-1",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
}

/** One OIDC sign-in of the address through the engine of plan 12d Task 4, with the fake IdP. */
async function sso(w: World, connectionId: string): Promise<Answer> {
  const started = await startSso(w.auth.config, { connectionId, next: "/", ip: null });
  if (!started.ok) throw new Error(started.code);
  const url = new URL(started.value.location);
  w.tokens["sso-token"] = {
    audience: "example-client",
    issuer: "https://login.example-idp.example",
    claims: { sub: "s-1", email: EMAIL, nonce: url.searchParams.get("nonce") ?? "" },
  };
  return completeSsoOidc(w.auth.config, {
    connectionId,
    state: url.searchParams.get("state") ?? "",
    code: "sso-token",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
}

/** An organization with the verified domain of the address and one OIDC connection: its id. */
async function ssoConnection(w: World): Promise<string> {
  const organizationId = await seedOrganization(w.auth, "acme");
  const added = await addDomain(w.auth.config, SSO_APP, { organizationId, domain: "example.com" });
  if (!added.ok || added.value.record === null) throw new Error("no domain record");
  w.txt[added.value.record.name] = [added.value.record.value];
  const verified = await verifyDomain(w.auth.config, SSO_APP, { id: added.value.id });
  if (!verified.ok) throw new Error(verified.code);
  const made = await createConnection(w.auth.config, SSO_APP, {
    organizationId,
    kind: "oidc",
    label: "Example IdP",
    issuer: "https://login.example-idp.example",
    clientId: "example-client",
    clientSecret: "example-secret-0123456789",
    endpoints: {
      authorizeUrl: "https://login.example-idp.example/authorize",
      tokenUrl: "https://login.example-idp.example/token",
      jwksUrl: "https://login.example-idp.example/keys",
    },
  });
  if (!made.ok) throw new Error(made.code);
  return made.value.id;
}

const PHONE = "+14155550100";

/** The code of the last SMS: the default text starts with it. */
function lastSms(w: World): string {
  return /^(\d+) /.exec(w.sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
}

/** One sign-in by a phone code (plan 12i Task 5). */
async function phoneCode(w: World): Promise<Answer> {
  const sent = await requestPhone(w.auth.config, { phone: PHONE, ip: null });
  if (!sent.ok) throw new Error(sent.code);
  return verifyPhone(w.auth.config, { phone: PHONE, code: lastSms(w), ip: null, userAgent: null });
}

/** The session token of a sign-in that must open a session. */
function tokenOf(r: Answer): string {
  if (!r.ok) throw new Error(r.code);
  const v = r.value as { token?: unknown };
  if (typeof v.token !== "string") throw new Error("the sign-in opened no session");
  return v.token;
}

interface Door {
  // An anonymous sign-in opens a session only for a new user, so no ban stands before it (plan 12i Task 6).
  via: Exclude<SessionVia, "impersonation" | "anonymous">;
  /** Signs the user up and in once through the flow, and answers the next try. */
  setup(w: World): Promise<() => Promise<Answer>>;
}

const DOORS: Door[] = [
  {
    via: "password",
    async setup(w) {
      await signUpAndVerify(w.auth, EMAIL, PASSWORD);
      tokenOf(await password(w));
      return () => password(w);
    },
  },
  {
    via: "magic_link",
    async setup(w) {
      tokenOf(await magicLink(w));
      return () => magicLink(w);
    },
  },
  {
    via: "social",
    async setup(w) {
      tokenOf(await social(w));
      return () => social(w);
    },
  },
  {
    via: "passkey",
    async setup(w) {
      tokenOf(await magicLink(w));
      const user = await userOf(w);
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
      const reg = await passkeyRegistrationOptions(w.auth.config, {
        session: await sessionFor(w.auth.config, user),
      });
      if (!reg.ok) throw new Error(reg.code);
      const stored = await verifyPasskeyRegistration(w.auth.config, {
        session: await sessionFor(w.auth.config, user),
        response: await soft.register(reg.value.challenge, new TextEncoder().encode(user.id)),
      });
      if (!stored.ok) throw new Error(stored.code);
      const authenticate = async () => {
        const options = await passkeyAuthenticationOptions(w.auth.config, { ip: null });
        if (!options.ok) throw new Error(options.code);
        return verifyPasskeyAuthentication(w.auth.config, {
          response: await soft.authenticate(options.value.challenge),
          ip: null,
          userAgent: null,
        });
      };
      tokenOf(await authenticate());
      return authenticate;
    },
  },
  {
    via: "handoff",
    async setup(w) {
      // The browser signs in, then continues the app's handoff.
      const browser = await resolveSession(w.auth.config, tokenOf(await magicLink(w)));
      if (!browser) throw new Error("no browser session");
      const handoff = async (session: { id: string; userId: string }) => {
        const verifier = randomBase64Url(32);
        const h = await startHandoff(w.auth.config, {
          challenge: await sha256Base64Url(verifier),
          redirect: "consumera://auth",
          ip: null,
        });
        if (!h.ok) throw new Error(h.code);
        const c = await continueHandoff(w.auth.config, {
          handoffId: h.value.handoffId,
          userId: session.userId,
          sessionId: session.id,
        });
        if (!c.ok) return c;
        return redeemHandoff(w.auth.config, {
          code: new URL(c.value.location).searchParams.get("code") ?? "",
          verifier,
          ip: null,
          userAgent: null,
        });
      };
      tokenOf(await handoff(browser.session));
      return async () => {
        // The ban ended the browser session: its continue answers invalid_token.
        expect(await handoff(browser.session)).toEqual({
          ok: false,
          code: "invalid_token",
          status: 400,
        });
        // The flow then needs a new browser sign-in, and the ban stops it.
        return magicLink(w);
      };
    },
  },
  {
    via: "email_otp",
    async setup(w) {
      tokenOf(await emailCode(w));
      return () => emailCode(w);
    },
  },
  {
    via: "phone",
    async setup(w) {
      // The user adds a phone by a real code (plan 12i Task 5), then signs in by a phone code.
      const session = await resolveSession(w.auth.config, tokenOf(await magicLink(w)));
      if (!session) throw new Error("no session");
      const sent = await addPhone(w.auth.config, { session, phone: PHONE, ip: null });
      if (!sent.ok) throw new Error(sent.code);
      const set = await verifyAddPhone(w.auth.config, {
        session,
        code: lastSms(w),
        ip: null,
        userAgent: null,
      });
      if (!set.ok) throw new Error(set.code);
      tokenOf(await phoneCode(w));
      return () => phoneCode(w);
    },
  },
  {
    via: "invite",
    async setup(w) {
      // The operator creates the user with an invitation (plan 12f2 Task 3).
      // The link is spent once, so the setup opens no session: the ban
      // refuses the first use, and the refusal leaves the link unspent.
      const made = await operatorApi(w.auth.config).users.create({
        actor: APP,
        email: EMAIL,
        reason: "Ticket 1",
        ip: null,
        userAgent: null,
      });
      if (!made.ok) throw new Error(made.code);
      const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
      return () => confirmUserInvite(w.auth.config, { token, ip: null, userAgent: null });
    },
  },
  {
    via: "sso",
    async setup(w) {
      // The first sign-in creates the user just in time (plan 12d Task 5).
      const connectionId = await ssoConnection(w);
      tokenOf(await sso(w, connectionId));
      return () => sso(w, connectionId);
    },
  },
];

const BANNED = { ok: false, code: "account_banned", status: 403 };

describe("the ban at the session doors (plan 12f Task 6)", () => {
  it("has one row per value of SessionVia but impersonation and anonymous", () => {
    expect(DOORS.map((d) => d.via).sort()).toEqual(
      Object.keys(SESSION_VIA)
        .filter((v) => v !== "impersonation" && v !== "anonymous")
        .sort(),
    );
  });

  it.each(DOORS)(
    "refuses a banned user after the credential check, at every door: $via",
    async (door) => {
      const w = await world();
      const again = await door.setup(w);
      await ban(w);
      w.before.length = 0;
      expect(await again()).toEqual(BANNED);
      // The stop comes before session.beforeCreate, and no session stays.
      expect(w.before).toEqual([]);
      const user = await userOf(w);
      expect(
        await w.auth.storage.findMany("session", [{ field: "userId", op: "eq", value: user.id }]),
      ).toEqual([]);
      if (door.via === "password")
        expect(await password(w, WRONG)).toEqual({
          ok: false,
          code: "invalid_credentials",
          status: 401,
        });
    },
  );

  it("gives a banned user with the factor on no challenge", async () => {
    const w = await world();
    const { session } = await enrolled(w.auth, EMAIL);
    const on = await enableEmailMethod(w.auth.config, { session, password: PASSWORD });
    if (!on.ok) throw new Error(on.code);
    await ban(w);
    const mails = w.auth.mail.length;
    expect(await password(w)).toEqual(BANNED);
    // The magic link opens a challenge through the gate of plan 12c: refused too.
    const sent = await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
    expect(sent).toEqual({ ok: true, value: { sent: true } });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    expect(await verifyMagicLink(w.auth.config, { token, ip: null, userAgent: null })).toEqual(
      BANNED,
    );
    // No challenge row, and no mail but the magic link that the user asked for.
    expect(
      await w.auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]),
    ).toEqual([]);
    expect(w.auth.mail.slice(mails).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Sign in to /),
    ]);
  });

  it("refuses the reset of a banned user with the factor on before the reset's writes", async () => {
    const w = await world();
    await enrolled(w.auth, EMAIL);
    await ban(w);
    const user = await userOf(w);
    expect(await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const writes = recordNextTransaction(w.auth.storage);
    expect(
      await resetPassword(w.auth.config, {
        token,
        password: "another long password",
        ip: null,
        userAgent: null,
      }),
    ).toEqual(BANNED);
    // The consume of the link is the one write before the stop, and the stop undoes it.
    expect(writes).toEqual(["update:verification"]);
    expect(await userOf(w)).toEqual(user);
  });

  // Three more flows open a session through prepareSession, as each door
  // above does (review L5 of Task 6).
  it("refuses the reset of a banned user with no factor, which opens a session", async () => {
    const w = await world();
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    await ban(w);
    const user = await userOf(w);
    expect(await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    w.before.length = 0;
    expect(
      await resetPassword(w.auth.config, {
        token,
        password: "another long password",
        ip: null,
        userAgent: null,
      }),
    ).toEqual(BANNED);
    expect(w.before).toEqual([]);
    expect(await w.auth.storage.findMany("session", [])).toEqual([]);
    // The stop undoes the reset: the old password stays, and the sign-in answers the ban.
    expect(await userOf(w)).toEqual(user);
    expect(await password(w)).toEqual(BANNED);
  });

  it("refuses the verify link of a sign-up when the ban came after the mail", async () => {
    const w = await world();
    const up = await passwordSignUp(w.auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const mail = w.auth.mail.findLast((m) => m.to === EMAIL && m.subject.startsWith("Confirm"));
    await ban(w);
    w.before.length = 0;
    expect(
      await verifyPasswordEmail(w.auth.config, {
        token: tokenFromMail(mail?.text ?? ""),
        ip: null,
        userAgent: null,
      }),
    ).toEqual(BANNED);
    expect(w.before).toEqual([]);
    expect(await w.auth.storage.findMany("session", [])).toEqual([]);
    expect((await userOf(w)).emailVerified).toBe(false);
  });

  it("ends a challenge that was open at the ban, so a right code opens nothing", async () => {
    const w = await world();
    const { secret } = await enrolled(w.auth, EMAIL);
    const r = await password(w);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the sign-in answered no challenge");
    const { challenge } = r.value.twoFactor;
    await ban(w);
    expect(
      await verifyTwoFactor(w.auth.config, {
        challenge,
        code: await codeNow(w.auth, secret),
        ip: null,
      }),
    ).toEqual({ ok: false, code: "invalid_token", status: 400 });
    expect(await w.auth.storage.findMany("session", [])).toEqual([]);
  });

  it("answers a banned user's mail request as any user's", async () => {
    const w = await world();
    tokenOf(await magicLink(w));
    await ban(w);
    expect(await requestMagicLink(w.auth.config, { email: EMAIL, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(
      await requestMagicLink(w.auth.config, { email: "nobody@example.com", ip: null }),
    ).toEqual({ ok: true, value: { sent: true } });
    expect(await requestEmailOtp(w.auth.config, { email: EMAIL, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
  });
});
