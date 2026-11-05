import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import type { Clock } from "../src/primitives/clock.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, post, tokenFromMail } from "./helpers.js";
import { FAST, proofCookie, pwHandle, SENT_WITH_PROOF } from "./password-helpers.js";
import { fakeJwt, GOOGLE, tokenEndpoint } from "./social-helpers.js";

type Rule = "open" | "invited" | false;
const NEW = "new@example.com";
const DAY = 86_400_000;

function authFor(signUp: Rule, extra: Partial<AuthConfig> = {}) {
  const input: Partial<AuthConfig> = {
    signUp,
    organizations: {},
    // The detailed answer (`sign_up_closed`, `email_taken`), which these tests
    // read. The uniform answer under each rule has its own tests (plan 12b).
    password: { hash: FAST, uniformSignUp: false },
    ...extra,
  };
  return makeAuth(input);
}

async function invite(
  auth: { clock: Clock; storage: StorageAdapter },
  email: string,
  expiresIn: number,
  accepted = false,
) {
  const now = auth.clock.now();
  // The invitation of an organization that exists: an invited sign-up reads it (ruling 78 of
  // plan 12d).
  if (!(await auth.storage.findOne("organization", [{ field: "id", op: "eq", value: "o1" }])))
    await auth.storage.create("organization", {
      id: "o1",
      slug: "o1",
      name: "O1",
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });
  await auth.storage.create("invitation", {
    id: `i-${email}-${expiresIn}`,
    organizationId: "o1",
    email,
    role: "member",
    inviterId: "u0",
    tokenHash: `h-${email}-${expiresIn}`,
    expiresAt: new Date(now.getTime() + expiresIn),
    acceptedAt: accepted ? now : null,
    teamIds: null,
    createdAt: now,
    updatedAt: now,
  });
}

const users = async (auth: ReturnType<typeof makeAuth>) =>
  (await auth.storage.findMany("user", [])).map((u) => u.email).sort();

async function viaMagicLink(auth: ReturnType<typeof makeAuth>, email: string) {
  await requestMagicLink(auth.config, { email, ip: null });
  const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
  return verifyMagicLink(auth.config, { token, ip: null, userAgent: null });
}

async function viaEmailCode(auth: ReturnType<typeof makeAuth>, email: string) {
  await requestEmailOtp(auth.config, { email, ip: null });
  const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
  return verifyEmailOtp(auth.config, { email, code, ip: null, userAgent: null });
}

async function viaSocial(signUp: Rule, email: string, opts = { verified: true, invited: false }) {
  const claims: Record<string, unknown> = {
    sub: `g-${email}`,
    email,
    email_verified: opts.verified,
  };
  const jwt = fakeJwt({
    "idtok-default": { claims, audience: GOOGLE.clientId, issuer: "https://accounts.google.com" },
  });
  const auth = authFor(signUp, {
    social: { google: GOOGLE, fetch: tokenEndpoint("idtok-default").fetchFn },
    jwt,
  });
  if (opts.invited) await invite(auth, email, DAY);
  const started = await startSocial(auth.config, { provider: "google", ip: null });
  if (!started.ok) throw new Error(started.code);
  const location = new URL(started.value.location);
  claims.nonce = location.searchParams.get("nonce");
  const r = await completeSocial(auth.config, {
    provider: "google",
    state: location.searchParams.get("state"),
    code: "c",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
  return { auth, r };
}

describe("the sign-up rule (plan 12b)", () => {
  it("is open by default, refuses another value, and refuses invited without organizations", () => {
    expect(makeAuth().config.signUp).toBe("open");
    // A value outside the type on purpose: the config must refuse it at run time.
    expect(() => makeAuth({ signUp: "closed" as never })).toThrow(
      new ConfigError('signUp must be "open", "invited", or false'),
    );
    expect(() => makeAuth({ signUp: "invited" })).toThrow(
      new ConfigError("signUp invited needs organizations: an invitation is the only way in"),
    );
  });

  it("refuses a new user at each of the four creates when sign-up is off, and writes no user", async () => {
    const ml = authFor(false);
    expect(await viaMagicLink(ml, NEW)).toMatchObject({ ok: false, code: "sign_up_closed" });
    const otp = authFor(false);
    expect(await viaEmailCode(otp, NEW)).toMatchObject({ ok: false, code: "sign_up_closed" });
    const social = await viaSocial(false, NEW);
    expect(social.r).toMatchObject({ ok: false, code: "sign_up_closed" });
    const pw = authFor(false);
    expect(
      await passwordSignUp(pw.config, {
        email: NEW,
        password: "correct horse battery",
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "sign_up_closed" });
    for (const a of [ml, otp, social.auth, pw]) expect(await users(a)).toEqual([]);
  });

  it("answers the password sign-up of a known address with sign_up_closed too, so it tells nothing", async () => {
    const auth = authFor(false);
    await auth.seedUser("ada@example.com");
    expect(
      await passwordSignUp(auth.config, {
        email: "ada@example.com",
        password: "correct horse battery",
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "sign_up_closed" });
    // Before the policy and the hash: a short password gets the same answer.
    expect(
      await passwordSignUp(auth.config, {
        email: "ada@example.com",
        password: "x",
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "sign_up_closed" });
  });

  it("answers the password sign-up under invited by the invitation, not by the address", async () => {
    const auth = authFor("invited");
    await auth.seedUser("ada@example.com");
    const up = (email: string) =>
      passwordSignUp(auth.config, {
        email,
        password: "correct horse battery",
        ip: null,
        userAgent: null,
      });
    expect(await up("ada@example.com")).toMatchObject({ ok: false, code: "sign_up_closed" });
    expect(await up(NEW)).toMatchObject({ ok: false, code: "sign_up_closed" });
    await invite(auth, NEW, DAY);
    expect((await up(NEW)).ok).toBe(true);
    expect(await users(auth)).toEqual(["ada@example.com", NEW]);
  });

  it("answers sent for every address under invited with uniformSignUp on, and mails only an invited one (plan 12b)", async () => {
    // The default answer: the extra password key drops the builder's uniformSignUp false.
    const auth = authFor("invited", { password: { hash: FAST } });
    await auth.seedUser("ada@example.com");
    const up = (email: string) =>
      passwordSignUp(auth.config, {
        email,
        password: "correct horse battery",
        ip: null,
        userAgent: null,
      });
    // No invitation: the same answer for a known and a new address, no row, and no mail.
    expect(await up("ada@example.com")).toEqual({ ok: true, value: SENT_WITH_PROOF });
    expect(await up(NEW)).toEqual({ ok: true, value: SENT_WITH_PROOF });
    expect(await users(auth)).toEqual(["ada@example.com"]);
    expect(auth.mail).toEqual([]);
    // An invitation: the same answer, the new user, and the verify mail.
    await invite(auth, NEW, DAY);
    expect(await up(NEW)).toEqual({ ok: true, value: SENT_WITH_PROOF });
    expect(await users(auth)).toEqual(["ada@example.com", NEW]);
    expect(auth.mail.map((m) => m.to)).toEqual([NEW]);
  });

  it("opens no session at the detailed sign-up of an invited address, and the verify link signs in", async () => {
    const h = pwHandle({ hash: FAST }, { signUp: "invited", organizations: {} });
    await invite(h, NEW, DAY);
    const res = await h.auth.handle(
      post("/auth/password/sign-up", { email: NEW, password: "correct horse battery" }),
    );
    const body = (await res.json()) as {
      verifyRequired?: unknown;
      token?: unknown;
      signUpProof: string;
    };
    // No session cookie: the one cookie is the sign-up proof (ruling 11 of plan 12q).
    expect({
      status: res.status,
      verifyRequired: body.verifyRequired,
      token: body.token,
      cookies: res.headers.getSetCookie().map((c) => c.split("=")[0]),
    }).toEqual({
      status: 200,
      verifyRequired: true,
      token: undefined,
      cookies: ["__Host-tempo_signup"],
    });
    expect(await h.storage.findMany("session", [])).toHaveLength(0);
    const v = await verifyPasswordEmail(h.config, {
      token: h.mails.at(-1)?.token ?? "",
      ip: null,
      userAgent: null,
      signUpProof: body.signUpProof,
    });
    expect(v.ok && v.value.signedIn !== null).toBe(true);
  });

  it("refuses the password sign-in of an unproved invited address until the verify link (Task 9 review M1)", async () => {
    for (const uniformSignUp of [true, false]) {
      const h = pwHandle({ hash: FAST, uniformSignUp }, { signUp: "invited", organizations: {} });
      await invite(h, NEW, DAY);
      const creds = { email: NEW, password: "correct horse battery" };
      const up = await h.auth.handle(post("/auth/password/sign-up", creds));
      expect(up.status).toBe(200);
      const { signUpProof } = (await up.json()) as { signUpProof: string };
      // A stranger who knows the invited address signs up with a password of their own.
      // The sign-in comes from the same browser, so its new link keeps the proof (plan 12q).
      const early = await h.auth.handle(post("/auth/password/sign-in", creds, proofCookie(up)));
      expect({ status: early.status, body: await early.json() }).toEqual({
        status: 403,
        body: { error: "email_unverified" },
      });
      expect(early.headers.get("set-cookie")).toBeNull();
      expect(await h.storage.findMany("session", [])).toHaveLength(0);
      // The link opens in the browser of the sign-up, with its proof, and then
      // the sign-in opens a session. Opened anywhere else, the link would claim
      // the address and delete this password (ruling 11 of plan 12q).
      const v = await verifyPasswordEmail(h.config, {
        token: h.mails.at(-1)?.token ?? "",
        ip: null,
        userAgent: null,
        signUpProof,
      });
      expect(v.ok && v.value.passwordKept).toBe(true);
      const late = await h.auth.handle(post("/auth/password/sign-in", creds));
      expect(late.status).toBe(200);
      expect(late.headers.get("set-cookie")).toMatch(/__Host-tempo_session=ts_/);
    }
  });

  it("refuses a social create under invited when the provider address is unverified", async () => {
    const unproved = await viaSocial("invited", NEW, { verified: false, invited: true });
    expect(unproved.r).toMatchObject({ ok: false, code: "sign_up_closed" });
    expect(await users(unproved.auth)).toEqual([]);
    const proved = await viaSocial("invited", NEW, { verified: true, invited: true });
    expect(proved.r.ok).toBe(true);
    expect(await users(proved.auth)).toEqual([NEW]);
  });

  it("keeps the reset link usable when the reset would create a user", async () => {
    const auth = authFor(false);
    await requestPasswordReset(auth.config, { email: NEW, ip: null });
    const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const input = { token, password: "correct horse battery", ip: null, userAgent: null };
    expect(await resetPassword(auth.config, input)).toMatchObject({
      ok: false,
      code: "sign_up_closed",
    });
    const row = await auth.storage.findOne("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(row?.consumedAt).toBeNull();
    expect(await users(auth)).toEqual([]);
  });

  it("signs in an existing user when sign-up is off", async () => {
    const auth = authFor(false);
    await auth.seedUser(NEW);
    expect((await viaMagicLink(auth, NEW)).ok).toBe(true);
    expect((await viaEmailCode(auth, NEW)).ok).toBe(true);
  });

  it("lets an invited address in, and refuses an expired, an accepted, and a missing invitation", async () => {
    const live = authFor("invited");
    await invite(live, NEW, DAY);
    expect((await viaMagicLink(live, NEW)).ok).toBe(true);
    const expired = authFor("invited");
    await invite(expired, NEW, -1);
    expect(await viaMagicLink(expired, NEW)).toMatchObject({ code: "sign_up_closed" });
    const accepted = authFor("invited");
    await invite(accepted, NEW, DAY, true);
    expect(await viaEmailCode(accepted, NEW)).toMatchObject({ code: "sign_up_closed" });
    // A revoked invitation is a deleted row: the same as none.
    expect(await viaMagicLink(authFor("invited"), NEW)).toMatchObject({ code: "sign_up_closed" });
  });
});
