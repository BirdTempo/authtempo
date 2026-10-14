import { createPbkdf2PasswordHash } from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";

/** A browser client with a verified user and the factor on; the clock then moves one step on. */
async function enrolled() {
  const server = makeServer({ password: { hash: FAST } });
  const { fetch } = inProcessFetch(server.auth);
  const browser = createClient({ baseURL: BASE_URL, fetch });
  await browser.password.signUp({ email: EMAIL, password: PW });
  const verified = await browser.password.verifyEmail({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
  });
  if (!verified.ok) throw new Error(verified.code);
  const setup = await browser.totp.setup({ password: PW });
  if (!setup.ok) throw new Error(setup.code);
  const secret = base32Decode(setup.value.secret);
  const enabled = await browser.totp.enable({ code: await totpCode(secret, server.clock.now()) });
  if (!enabled.ok) throw new Error(enabled.code);
  server.clock.advance(30_000);
  const code = () => totpCode(secret, server.clock.now());
  return { server, fetch, browser, setup: setup.value, enabled: enabled.value, code };
}

describe("totp (plan 9f)", () => {
  it("sets up, enables, and reads the status, with ISO dates", async () => {
    const { browser, setup, enabled } = await enrolled();
    expect(setup.uri.startsWith("otpauth://totp/")).toBe(true);
    expect(setup.backupCodes).toHaveLength(10);
    expect(enabled).toEqual({
      enabled: true,
      enabledAt: "2026-01-01T00:00:00.000Z",
      backupCodesLeft: 10,
      trustedDevices: 0,
      methods: ["totp"],
      backupCodesVersion: 2,
    });
    expect(await browser.totp.status()).toEqual({ ok: true, value: enabled });
  });

  it("sends the password at the setup: a wrong one answers invalid_credentials and writes no setup (review I-1)", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch } = inProcessFetch(server.auth);
    const browser = createClient({ baseURL: BASE_URL, fetch });
    await browser.password.signUp({ email: EMAIL, password: PW });
    await browser.password.verifyEmail({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
    expect(await browser.totp.setup({ password: "not the password" })).toEqual({
      ok: false,
      code: "invalid_credentials",
      status: 401,
    });
    expect(await server.storage.findMany("totp", [])).toEqual([]);
    expect((await browser.totp.setup({ password: PW })).ok).toBe(true);
  });

  it("verifies with a backup code, and signIn sends next to the challenge (parked Minor 6.1)", async () => {
    const { fetch, setup } = await enrolled();
    const native = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    const first = await native.password.signIn({ email: EMAIL, password: PW, next: "/inbox" });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    const v = await native.totp.verify({
      challenge: first.value.twoFactor.challenge,
      backupCode: setup.backupCodes[0] ?? "",
    });
    expect(v).toMatchObject({ ok: true, value: { next: "/inbox", backupCodesLeft: 9 } });
  });

  it("signs in with a challenge, and a native client verifies it with a code and keeps the token", async () => {
    const { fetch, code } = await enrolled();
    const native = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    const first = await native.password.signIn({ email: EMAIL, password: PW });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    expect(first.value.twoFactor.challenge).toMatch(/^tf_/);
    const v = await native.totp.verify({
      challenge: first.value.twoFactor.challenge,
      code: await code(),
    });
    if (!v.ok) throw new Error(v.code);
    expect(v.value).toMatchObject({
      user: { email: EMAIL },
      next: "/",
      backupCodesLeft: 10,
      trustDevice: null,
    });
    expect(v.value.token).toMatch(/^ts_/);
    expect(
      await native.totp.verify({ challenge: first.value.twoFactor.challenge, code: await code() }),
    ).toEqual({ ok: false, code: "invalid_token", status: 400 });
  });

  it("trusts the device: the next sign-in with the token in the body opens a session", async () => {
    const { fetch, code } = await enrolled();
    const native = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    const first = await native.password.signIn({ email: EMAIL, password: PW });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    const v = await native.totp.verify({
      challenge: first.value.twoFactor.challenge,
      code: await code(),
      trustDevice: true,
    });
    if (!v.ok || !v.value.trustDevice) throw new Error("no trusted device");
    const again = await native.password.signIn({
      email: EMAIL,
      password: PW,
      trustDevice: v.value.trustDevice.token,
    });
    expect(again.ok && "token" in again.value).toBe(true);
  });

  it("regenerates the backup codes, revokes the trusted devices, and disables", async () => {
    const { browser, code, server } = await enrolled();
    const fresh = await browser.totp.regenerateBackupCodes({ code: await code() });
    expect(fresh.ok && fresh.value.backupCodes).toHaveLength(10);
    expect(await browser.totp.revokeTrustedDevices()).toEqual({ ok: true, value: { ok: true } });
    server.clock.advance(30_000);
    const right = await code();
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await browser.totp.disable({ code: wrong })).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
    expect(await browser.totp.disable({ code: right })).toEqual({ ok: true, value: { ok: true } });
    expect(await browser.totp.status()).toMatchObject({ ok: true, value: { enabled: false } });
  });

  it("answers not_found with totp: false", async () => {
    const server = makeServer({ password: { hash: FAST }, totp: false });
    const { fetch } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    expect(await client.totp.status()).toEqual({ ok: false, code: "not_found", status: 404 });
  });
});
