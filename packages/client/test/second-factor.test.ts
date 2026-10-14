import { createPbkdf2PasswordHash } from "@authtempo/core";
import { base32Decode, SoftAuthenticator, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import type { BrowserWebAuthn } from "../src/webauthn.js";
import { APP_ORIGIN, BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";
const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };

/** A seam over the soft authenticator, so the ceremonies run with no browser. */
function softSeam(soft: SoftAuthenticator): BrowserWebAuthn {
  return {
    create: (options) => soft.register(options.challenge),
    get: (options) => soft.authenticate(options.challenge),
  };
}

/** A browser client of a verified user with a password. */
async function verifiedBrowser(server: ReturnType<typeof makeServer>, webauthn?: BrowserWebAuthn) {
  const { fetch } = inProcessFetch(server.auth);
  const browser = createClient({ baseURL: BASE_URL, fetch, ...(webauthn ? { webauthn } : {}) });
  await browser.password.signUp({ email: EMAIL, password: PW });
  const verified = await browser.password.verifyEmail({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
  });
  if (!verified.ok) throw new Error(verified.code);
  return { fetch, browser };
}

/** The TOTP method on through the client; the clock then moves one step on. */
async function totpOn(
  server: ReturnType<typeof makeServer>,
  browser: ReturnType<typeof createClient>,
) {
  const setup = await browser.totp.setup({ password: PW });
  if (!setup.ok) throw new Error(setup.code);
  const secret = base32Decode(setup.value.secret);
  const on = await browser.totp.enable({ code: await totpCode(secret, server.clock.now()) });
  if (!on.ok) throw new Error(on.code);
  server.clock.advance(30_000);
  return () => totpCode(secret, server.clock.now());
}

describe("the second factor through the client (plan 12c)", () => {
  it("answers a gated reset with the challenge and its methods, and totp.verify opens the session", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch, browser } = await verifiedBrowser(server);
    const code = await totpOn(server, browser);
    const native = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    await native.password.requestReset({ email: EMAIL });
    const r = await native.password.reset({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      password: "a brand new long password",
    });
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the reset answered no challenge");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    const v = await native.totp.verify({
      challenge: r.value.twoFactor.challenge,
      code: await code(),
    });
    expect(v.ok && v.value.token.startsWith("ts_")).toBe(true);
  });

  it("passes a gated reset with the trust token of an earlier verify", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch, browser } = await verifiedBrowser(server);
    const code = await totpOn(server, browser);
    const native = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    const first = await native.password.signIn({ email: EMAIL, password: PW });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    const v = await native.totp.verify({
      challenge: first.value.twoFactor.challenge,
      code: await code(),
      trustDevice: true,
    });
    if (!v.ok || v.value.trustDevice === null) throw new Error("no trust token");
    await native.password.requestReset({ email: EMAIL });
    const r = await native.password.reset({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      password: "a brand new long password",
      trustDevice: v.value.trustDevice.token,
    });
    if (!r.ok || "twoFactor" in r.value) throw new Error("the reset answered no session");
    expect(r.value.token.startsWith("ts_")).toBe(true);
  });

  it("answers a gated magic link with the challenge", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { browser } = await verifiedBrowser(server);
    await totpOn(server, browser);
    await browser.magicLink.request({ email: EMAIL });
    const r = await browser.magicLink.verify({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
    });
    expect(r.ok && "twoFactor" in r.value).toBe(true);
  });

  it("turns the passkey method on and passes a challenge with the passkey", async () => {
    const server = makeServer({ password: { hash: FAST }, passkey: RP });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const { fetch, browser } = await verifiedBrowser(server, softSeam(soft));
    expect((await browser.passkey.register({ name: "laptop" })).ok).toBe(true);
    const on = await browser.secondFactor.passkey.enable({ password: PW });
    if (!on.ok) throw new Error(on.code);
    expect(on.value.methods).toEqual(["passkey"]);
    expect(on.value.backupCodes).toHaveLength(10);
    const native = createClient({
      baseURL: BASE_URL,
      fetch,
      credentials: "omit",
      webauthn: softSeam(soft),
    });
    const first = await native.password.signIn({ email: EMAIL, password: PW });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    expect(first.value.twoFactor.methods).toEqual(["passkey", "backup"]);
    const v = await native.secondFactor.passkey.verify({
      challenge: first.value.twoFactor.challenge,
    });
    expect(v.ok && v.value.token.startsWith("ts_")).toBe(true);
  });

  it("turns the email method on, sends a code, verifies with it, and turns the method off", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch, browser } = await verifiedBrowser(server);
    await totpOn(server, browser);
    expect(await browser.secondFactor.email.enable({ password: PW })).toEqual({
      ok: true,
      value: { methods: ["totp", "email"], backupCodes: [] },
    });
    const native = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    const first = await native.password.signIn({ email: EMAIL, password: PW });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    const challenge = first.value.twoFactor.challenge;
    expect(await native.secondFactor.email.send({ challenge })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const emailCode = /\b(\d{6})\b/.exec(server.mail.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await native.totp.verify({ challenge, emailCode })).ok).toBe(true);
    expect(await browser.secondFactor.disable({ method: "email", password: PW })).toEqual({
      ok: true,
      value: { ok: true, methods: ["totp"] },
    });
  });
});
