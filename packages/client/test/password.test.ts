import { createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";

describe("password", () => {
  it("answers the user, verifyRequired, and no cookie at sign-up with password.requireVerified (plan 12b)", async () => {
    const server = makeServer({ password: { hash: FAST, requireVerified: true } });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({ email: EMAIL, password: PW });
    expect(up.ok && up.value).toMatchObject({ verifyRequired: true, user: { email: EMAIL } });
    expect(up.ok && "token" in up.value).toBe(false);
    expect(jar.size).toBe(0);
  });

  it("signs up, signs in, resets, and changes, with the cookie and with the bearer token", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({ email: EMAIL, password: PW });
    expect(up.ok && "token" in up.value && up.value.token).toMatch(/^ts_/);
    expect(up.ok && up.value.user.emailVerified).toBe(false);
    expect(jar.size).toBe(1);
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
    expect(await client.password.verifyEmail({ token })).toEqual({
      ok: true,
      value: { verified: true },
    });
    const s = await client.session();
    expect(s.ok && s.value?.user.emailVerified).toBe(true);
    expect(await client.password.verifyEmail({ token })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
  });
});
