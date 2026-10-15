import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { defaultAccountMail } from "../src/engine/account-mail.js";
import { requestEmailOtp } from "../src/engine/email-otp.js";
import { requireFresh } from "../src/engine/fresh.js";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "../src/engine/passkeys.js";
import { reauthenticate, reauthPasskeyOptions, requestReauthCode } from "../src/engine/reauth.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { UserRow } from "../src/schema.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { makeAuth, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type Auth, EMAIL, enrolled, totpAuth, verifiedSession } from "./totp-helpers.js";

const DAY = 86_400_000;
const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };

async function stale(auth: Auth, token: string) {
  auth.clock.advance(DAY);
  const s = await resolveSession(auth.config, token);
  if (!s) throw new Error("the session ended");
  return s;
}

/** The session row as storage holds it now, held to the fresh rule. */
async function freshNow(auth: Auth, token: string) {
  const s = await resolveSession(auth.config, token);
  if (!s) throw new Error("the session ended");
  return requireFresh(auth.config, s.session);
}

const codeOf = (auth: Auth) => /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";

function passkeyAuth() {
  return makeAuth({ password: { hash: FAST }, passkey: RP });
}

async function registered(auth: Auth, user: UserRow) {
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
  const options = await passkeyRegistrationOptions(auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const r = await verifyPasskeyRegistration(auth.config, {
    user,
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!r.ok) throw new Error(r.code);
  return soft;
}

describe("the re-authentication by an email code (plan 12a)", () => {
  it("mails a code to the user's address, and the code makes the session fresh once", async () => {
    const auth = totpAuth();
    const { token } = await verifiedSession(auth);
    const old = await stale(auth, token);
    expect(await requestReauthCode(auth.config, { session: old })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(auth.mail.at(-1)).toMatchObject({
      to: EMAIL,
      subject: "Your confirmation code for api.example.com",
    });
    const code = codeOf(auth);
    const proof = { emailCode: code };
    expect(await freshNow(auth, token)).toMatchObject({ ok: false, code: "session_not_fresh" });
    expect((await reauthenticate(auth.config, { session: old, proof, ip: null })).ok).toBe(true);
    expect(await freshNow(auth, token)).toEqual({ ok: true, value: true });
    expect(await reauthenticate(auth.config, { session: old, proof, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
  });

  it("sends at most 3 codes per user in 15 minutes", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    for (let i = 0; i < 3; i++)
      expect((await requestReauthCode(auth.config, { session: s })).ok).toBe(true);
    expect(await requestReauthCode(auth.config, { session: s })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });

  it("shares the per-address budget of every mailed code with the sign-in code", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    for (let i = 0; i < 3; i++)
      expect((await requestEmailOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    expect(await requestReauthCode(auth.config, { session: s })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });

  it("refuses a sign-in code as a re-authentication code", async () => {
    const auth = totpAuth();
    const old = await stale(auth, (await verifiedSession(auth)).token);
    expect((await requestEmailOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    expect(
      await reauthenticate(auth.config, {
        session: old,
        proof: { emailCode: codeOf(auth) },
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_code" });
  });

  it("sends the code to the user's address whatever the mail builder answers", async () => {
    const auth = totpAuth({
      account: { mail: (input) => ({ ...defaultAccountMail(input), to: "thief@example.com" }) },
    });
    const s = await verifiedSession(auth);
    await requestReauthCode(auth.config, { session: s });
    expect(auth.mail.at(-1)?.to).toBe(EMAIL);
  });

  it("asks for the second-factor code after an email code when the factor is on", async () => {
    const auth = totpAuth();
    const { session } = await enrolled(auth);
    const old = await stale(auth, session.token);
    await requestReauthCode(auth.config, { session: old });
    expect(
      await reauthenticate(auth.config, {
        session: old,
        proof: { emailCode: codeOf(auth) },
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("answers not_found for the request and the proof with emailOtp off", async () => {
    const auth = totpAuth({ emailOtp: false });
    const s = await verifiedSession(auth);
    expect(await requestReauthCode(auth.config, { session: s })).toMatchObject({
      code: "not_found",
    });
    expect(
      await reauthenticate(auth.config, { session: s, proof: { emailCode: "123456" }, ip: null }),
    ).toMatchObject({ code: "not_found" });
  });
});

describe("the re-authentication by a passkey (plan 12a)", () => {
  it("makes the session fresh with a passkey of the user, with no factor code", async () => {
    const auth = passkeyAuth();
    const signedIn = await verifiedSession(auth);
    const soft = await registered(auth, signedIn.user);
    const old = await stale(auth, signedIn.token);
    const options = await reauthPasskeyOptions(auth.config, { session: old, ip: null });
    if (!options.ok) throw new Error(options.code);
    expect(options.value.allowCredentials?.map((c) => c.id)).toEqual([soft.credentialId]);
    const r = await reauthenticate(auth.config, {
      session: old,
      proof: { passkey: await soft.authenticate(options.value.challenge) },
      ip: null,
    });
    expect(r.ok).toBe(true);
    expect(await freshNow(auth, signedIn.token)).toEqual({ ok: true, value: true });
  });

  it("refuses a passkey of another user, and a spent challenge", async () => {
    const auth = passkeyAuth();
    const ada = await verifiedSession(auth);
    const bob = await verifiedSession(auth, "bob@example.com");
    const adaKey = await registered(auth, ada.user);
    const bobKey = await registered(auth, bob.user);
    const first = await reauthPasskeyOptions(auth.config, { session: ada, ip: null });
    if (!first.ok) throw new Error(first.code);
    expect(
      await reauthenticate(auth.config, {
        session: ada,
        proof: { passkey: await bobKey.authenticate(first.value.challenge) },
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "passkey_failed" });
    const second = await reauthPasskeyOptions(auth.config, { session: ada, ip: null });
    if (!second.ok) throw new Error(second.code);
    const response = await adaKey.authenticate(second.value.challenge);
    expect(
      (await reauthenticate(auth.config, { session: ada, proof: { passkey: response }, ip: null }))
        .ok,
    ).toBe(true);
    expect(
      await reauthenticate(auth.config, { session: ada, proof: { passkey: response }, ip: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
  });
});

describe("the account config (plan 12a)", () => {
  it("refuses an unknown account key and a mail that is no function", () => {
    expect(() => totpAuth({ account: { mail: defaultAccountMail, notices: {} } as never })).toThrow(
      new ConfigError("account.notices is not an option; core has mail"),
    );
    expect(() => totpAuth({ account: { mail: "x" } as never })).toThrow(
      new ConfigError("account.mail must be a function"),
    );
  });
});

describe("the re-authentication routes (plan 12a)", () => {
  it("serves the code request and the passkey options, and refuses two first proofs", async () => {
    const auth = passkeyAuth();
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const { token } = await verifiedSession(auth);
    const bearer = { authorization: `Bearer ${token}` };
    const mailed = await handle(post("/auth/reauth/email", {}, bearer));
    expect(mailed.status).toBe(200);
    expect(await mailed.json()).toEqual({ sent: true });
    const options = await handle(post("/auth/reauth/passkey/options", {}, bearer));
    expect(options.status).toBe(200);
    expect(await options.json()).toHaveProperty("challenge");
    for (const body of [
      { password: "x", emailCode: "123456" },
      {},
      { passkey: { id: "a", response: { clientDataJSON: "e30" } }, code: "123456" },
    ]) {
      const res = await handle(post("/auth/reauth", body, bearer));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
  });
});
