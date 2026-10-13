import { createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";

/** The code in the newest mail. */
function codeOf(server: ReturnType<typeof makeServer>): string {
  const m = /\b(\d{6})\b/.exec(server.mail.at(-1)?.text ?? "");
  if (!m?.[1]) throw new Error("no code mailed");
  return m[1];
}

describe("emailOtp (plan 9e)", () => {
  it("requests and verifies a sign-in code with the cookie, and the token works as a bearer", async () => {
    const server = makeServer();
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    expect(await client.emailOtp.request({ email: EMAIL })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = codeOf(server);
    // The attempt budget: one wrong code of the default maxAttempts 5, so
    // the right code that follows is still live. A config with maxAttempts 1
    // is refused (3 to 10), so this test cannot spend the code by accident.
    expect(
      await client.emailOtp.verify({ email: EMAIL, code: code === "000000" ? "111111" : "000000" }),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    const v = await client.emailOtp.verify({ email: EMAIL, code });
    if (!v.ok) throw new Error(v.code);
    expect(v.value.token).toMatch(/^ts_/);
    expect(v.value.user).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(jar.size).toBe(1);
    const bearer = createClient({
      baseURL: BASE_URL,
      fetch,
      credentials: "omit",
      token: () => v.value.token,
    });
    const s = await bearer.session();
    expect(s.ok && s.value?.user.email).toBe(EMAIL);
  });

  it("requests a reset code and resets; without a password config both answer not_found", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    expect(await client.emailOtp.requestReset({ email: EMAIL })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const r = await client.emailOtp.reset({
      email: EMAIL,
      code: codeOf(server),
      password: "a new long password",
    });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.token).toMatch(/^ts_/);
    expect(
      (await client.password.signIn({ email: EMAIL, password: "a new long password" })).ok,
    ).toBe(true);
    const plain = makeServer();
    const other = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(plain.auth).fetch });
    expect(await other.emailOtp.requestReset({ email: EMAIL })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("posts exactly the documented paths and bodies", async () => {
    const seen: { path: string; body: string }[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({ path: new URL(req.url).pathname, body: await req.text() });
        return Response.json({ sent: true });
      }) as typeof fetch,
    });
    await client.emailOtp.request({ email: EMAIL });
    await client.emailOtp.verify({ email: EMAIL, code: "123456" });
    await client.emailOtp.requestReset({ email: EMAIL });
    await client.emailOtp.reset({ email: EMAIL, code: "123456", password: "pw" });
    expect(seen).toEqual([
      { path: "/auth/otp/request", body: '{"email":"ada@example.com"}' },
      { path: "/auth/otp/verify", body: '{"email":"ada@example.com","code":"123456"}' },
      { path: "/auth/otp/reset/request", body: '{"email":"ada@example.com"}' },
      {
        path: "/auth/otp/reset",
        body: '{"email":"ada@example.com","code":"123456","password":"pw"}',
      },
    ]);
  });
});
