import { CAPTCHA_HEADER, createPbkdf2PasswordHash } from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";

async function verifiedUser(server: ReturnType<typeof makeServer>) {
  const owner = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
  await owner.password.signUp({ email: EMAIL, password: PW });
  const v = await owner.password.verifyEmail({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
  });
  if (!v.ok) throw new Error(v.code);
  return owner;
}

describe("client.signIn.password (plan 11d)", () => {
  it("answers the session for a user with no second factor, and the store reads it", async () => {
    const server = makeServer({ password: { hash: FAST } });
    await verifiedUser(server);
    const browser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const stop = browser.store.subscribe(() => {});
    const r = await browser.signIn.password({ email: EMAIL, password: PW });
    if (!r.ok || r.value.kind !== "session") throw new Error("no session");
    expect(r.value.session.user.email).toBe(EMAIL);
    await vi.waitFor(() => expect(browser.store.get().data?.user.email).toBe(EMAIL));
    stop();
  });

  it("answers the second factor step, whose verify opens the session", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const owner = await verifiedUser(server);
    const setup = await owner.totp.setup({ password: PW });
    if (!setup.ok) throw new Error(setup.code);
    const secret = base32Decode(setup.value.secret);
    const enabled = await owner.totp.enable({ code: await totpCode(secret, server.clock.now()) });
    if (!enabled.ok) throw new Error(enabled.code);
    server.clock.advance(30_000);

    const browser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const stop = browser.store.subscribe(() => {});
    const r = await browser.signIn.password({ email: EMAIL, password: PW });
    if (!r.ok || r.value.kind !== "second-factor") throw new Error("no second factor step");
    expect(typeof r.value.challenge).toBe("string");
    expect(await browser.session()).toEqual({ ok: true, value: null });
    const wrong = await r.value.verify({ code: "000000" });
    expect(wrong.ok).toBe(false);
    const done = await r.value.verify({ code: await totpCode(secret, server.clock.now()) });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.user.email).toBe(EMAIL);
    await vi.waitFor(() => expect(browser.store.get().data?.user.email).toBe(EMAIL));
    stop();
  });

  it("verifies with a backup code and asks for a trusted device", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const owner = await verifiedUser(server);
    const setup = await owner.totp.setup({ password: PW });
    if (!setup.ok) throw new Error(setup.code);
    const enabled = await owner.totp.enable({
      code: await totpCode(base32Decode(setup.value.secret), server.clock.now()),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    const browser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const r = await browser.signIn.password({ email: EMAIL, password: PW });
    if (!r.ok || r.value.kind !== "second-factor") throw new Error("no second factor step");
    const done = await r.value.verify(
      { backupCode: setup.value.backupCodes[0] ?? "" },
      { trustDevice: true },
    );
    if (!done.ok) throw new Error(done.code);
    expect(done.value.trustDevice?.token).toBeTypeOf("string");
  });

  it("passes a failure through with its code", async () => {
    const server = makeServer({ password: { hash: FAST } });
    await verifiedUser(server);
    const browser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await browser.signIn.password({ email: EMAIL, password: "wrong" })).toEqual({
      ok: false,
      code: "invalid_credentials",
      status: 401,
    });
  });
});

describe("client.signIn.password fix round (plan 11d Task 6 review)", () => {
  it("sends captchaToken in the captcha header (M1)", async () => {
    const headers: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get(CAPTCHA_HEADER));
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    };
    const client = createClient({ baseURL: BASE_URL, fetch });
    await client.signIn.password({ email: EMAIL, password: PW, captchaToken: "tok" });
    expect(headers).toEqual(["tok"]);
  });

  it("shows the methods of the challenge (M2)", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const owner = await verifiedUser(server);
    const setup = await owner.totp.setup({ password: PW });
    if (!setup.ok) throw new Error(setup.code);
    const enabled = await owner.totp.enable({
      code: await totpCode(base32Decode(setup.value.secret), server.clock.now()),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    const browser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const r = await browser.signIn.password({ email: EMAIL, password: PW });
    if (!r.ok || r.value.kind !== "second-factor") throw new Error("no second factor step");
    expect(r.value.methods).toEqual(["totp", "backup"]);
  });

  it("verifies the email method with an email code (M2)", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const owner = await verifiedUser(server);
    const on = await owner.secondFactor.email.enable({ password: PW });
    if (!on.ok) throw new Error(on.code);
    const browser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const r = await browser.signIn.password({ email: EMAIL, password: PW });
    if (!r.ok || r.value.kind !== "second-factor") throw new Error("no second factor step");
    expect(r.value.methods).toContain("email");
    const sent = await browser.secondFactor.email.send({ challenge: r.value.challenge });
    if (!sent.ok) throw new Error(sent.code);
    const emailCode = /\b(\d{6})\b/.exec(server.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const done = await r.value.verify({ emailCode });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.user.email).toBe(EMAIL);
  });
});
