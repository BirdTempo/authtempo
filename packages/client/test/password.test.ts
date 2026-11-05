import { CAPTCHA_HEADER, createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";

describe("password", () => {
  it("answers sent and no cookie at sign-up by default, and the verify link opens the session (plan 12b)", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    // The answer and the one cookie carry the sign-up proof, and no session (plan 12q).
    expect(await client.password.signUp({ email: EMAIL, password: PW })).toEqual({
      ok: true,
      value: { sent: true, signUpProof: expect.stringMatching(/^sp_/) },
    });
    expect([...jar.keys()]).toEqual(["__Host-tempo_signup"]);
    const v = await client.password.verifyEmail({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
    });
    expect(v.ok && v.value.passwordKept).toBe(true);
    // The confirm cleared the proof and set the session cookie.
    expect([...jar.keys()]).toEqual(["__Host-tempo_session"]);
  });

  it("answers the user, verifyRequired, and no cookie at sign-up with password.requireVerified (plan 12b)", async () => {
    const server = makeServer({
      password: { hash: FAST, requireVerified: true, uniformSignUp: false },
    });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({ email: EMAIL, password: PW });
    expect(up.ok && up.value).toMatchObject({ verifyRequired: true, user: { email: EMAIL } });
    expect(up.ok && "token" in up.value).toBe(false);
    // No session cookie: the one cookie is the sign-up proof (plan 12q).
    expect([...jar.keys()]).toEqual(["__Host-tempo_signup"]);
  });

  it("signs up, signs in, resets, and changes, with the cookie and with the bearer token", async () => {
    // The detailed answer of plan 8: a session at sign-up (plan 12b).
    const server = makeServer({ password: { hash: FAST, uniformSignUp: false } });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({ email: EMAIL, password: PW });
    expect(up.ok && "token" in up.value && up.value.token).toMatch(/^ts_/);
    expect(up.ok && "token" in up.value && up.value.user.emailVerified).toBe(false);
    // The session cookie, and the sign-up proof (plan 12q).
    expect([...jar.keys()].sort()).toEqual(["__Host-tempo_session", "__Host-tempo_signup"]);
    expect(await client.password.signIn({ email: EMAIL, password: "wrong password" })).toEqual({
      ok: false,
      code: "invalid_credentials",
      status: 401,
    });
    expect(await client.password.requestReset({ email: EMAIL })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const token = tokenFromMail(server.mail.at(-1)?.text ?? "");
    const reset = await client.password.reset({ token, password: "new password 1" });
    if (!reset.ok) throw new Error(reset.code);
    if ("twoFactor" in reset.value) throw new Error("no session: a second-factor challenge");
    expect(reset.value.user.emailVerified).toBe(true);
    const sessionToken = reset.value.token;
    const bearer = createClient({
      baseURL: BASE_URL,
      fetch,
      credentials: "omit",
      token: () => sessionToken,
    });
    expect(
      await bearer.password.change({
        currentPassword: "new password 1",
        newPassword: "changed password",
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect((await client.password.signIn({ email: EMAIL, password: "changed password" })).ok).toBe(
      true,
    );
  });

  /** A client whose fetch records each request body as text. */
  function recordingClient() {
    const bodies: string[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await new Request(input, init).text());
        return Response.json({ sent: true });
      }) as typeof fetch,
    });
    return { client, bodies };
  }

  // JSON drops an undefined value, so this test cannot catch a missing
  // conditional. The next test pins the conditionals with set values.
  it("sends no key for an optional field the caller did not set", async () => {
    const { client, bodies } = recordingClient();
    await client.password.signUp({ email: EMAIL, password: PW });
    await client.password.requestReset({ email: EMAIL });
    await client.password.change({ newPassword: "first password" });
    expect(bodies).toEqual([
      `{"email":"${EMAIL}","password":"${PW}"}`,
      `{"email":"${EMAIL}"}`,
      `{"newPassword":"first password"}`,
    ]);
  });

  it("sends name, next, and currentPassword when the caller sets them (plan 8 final review T8)", async () => {
    const { client, bodies } = recordingClient();
    await client.password.signUp({ email: EMAIL, password: PW, name: "Ada" });
    await client.password.requestReset({ email: EMAIL, next: "/home" });
    await client.password.change({ currentPassword: PW, newPassword: "second password" });
    expect(bodies.map((b) => JSON.parse(b))).toEqual([
      { email: EMAIL, password: PW, name: "Ada" },
      { email: EMAIL, next: "/home" },
      { currentPassword: PW, newPassword: "second password" },
    ]);
  });

  it("answers not_found when the server has no password config", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await client.password.signIn({ email: EMAIL, password: PW })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("resends the verify mail and confirms the address with verifyEmail (plan 8b)", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    await client.password.signUp({ email: EMAIL, password: PW });
    expect(await client.password.resendVerification({ email: EMAIL })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(server.mail).toHaveLength(2);
    const token = tokenFromMail(server.mail.at(-1)?.text ?? "");
    // The jar holds the sign-up proof, and the resend kept its hash (plan 12q).
    expect(await client.password.verifyEmail({ token })).toEqual({
      ok: true,
      value: { verified: true, passwordKept: true },
    });
    const s = await client.session();
    expect(s.ok && s.value?.user.emailVerified).toBe(true);
    expect(await client.password.verifyEmail({ token })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
  });

  it("passes signUpProof at a bearer sign-in, so the new code keeps the password (plan 12q)", async () => {
    const server = makeServer({
      password: { hash: FAST, requireVerified: true, verifyBy: "code" },
    });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({ email: EMAIL, password: PW });
    if (!up.ok) throw new Error(up.code);
    const signUpProof = up.value.signUpProof;
    // A native app has no cookie jar: it keeps only the answer's proof.
    jar.clear();
    expect(await client.password.signIn({ email: EMAIL, password: PW, signUpProof })).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
    expect(server.mail).toHaveLength(2);
    const code = /^(\d{6}) is your /.exec(server.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const v = await client.password.verifyCode({ email: EMAIL, code, signUpProof });
    expect(v.ok && v.value.passwordKept).toBe(true);
  });

  it("sends captchaToken in the x-captcha-response header and never in the body (plan 12b)", async () => {
    const seen: Array<{ url: string; header: string | null; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({
        url: String(input),
        // Core's name: the client's copy must match it.
        header: new Headers(init?.headers).get(CAPTCHA_HEADER),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ sent: true });
    };
    const client = createClient({ baseURL: BASE_URL, fetch });
    const captchaToken = "tok";
    await client.password.signUp({ email: EMAIL, password: PW, captchaToken });
    await client.password.signIn({ email: EMAIL, password: PW, captchaToken });
    await client.password.requestReset({ email: EMAIL, captchaToken });
    await client.magicLink.request({ email: EMAIL, captchaToken });
    await client.emailOtp.request({ email: EMAIL, captchaToken });
    await client.emailOtp.requestReset({ email: EMAIL, captchaToken });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/auth/password/sign-up",
      "/auth/password/sign-in",
      "/auth/password/reset/request",
      "/auth/magic-link/request",
      "/auth/otp/request",
      "/auth/otp/reset/request",
    ]);
    for (const s of seen) {
      expect(s.header).toBe("tok");
      expect(s.body).not.toHaveProperty("captchaToken");
    }
    await client.password.signUp({ email: EMAIL, password: PW });
    expect(seen.at(-1)?.header).toBeNull();
  });
});
