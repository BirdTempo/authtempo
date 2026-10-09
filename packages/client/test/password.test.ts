import { createPbkdf2PasswordHash } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";

describe("password", () => {
  it("signs up, signs in, resets, and changes, with the cookie and with the bearer token", async () => {
    const server = makeServer({ password: { hash: FAST } });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({ email: EMAIL, password: PW });
    expect(up.ok && up.value.token).toMatch(/^ts_/);
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
    expect(reset.value.user.emailVerified).toBe(true);
    const bearer = createClient({
      baseURL: BASE_URL,
      fetch,
      credentials: "omit",
      token: () => reset.value.token,
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

  it("sends only the fields the caller set", async () => {
    const bodies: string[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await new Request(input, init).text());
        return Response.json({ sent: true });
      }) as typeof fetch,
    });
    await client.password.signUp({ email: EMAIL, password: PW });
    await client.password.requestReset({ email: EMAIL });
    await client.password.change({ newPassword: "first password" });
    expect(bodies).toEqual([
      `{"email":"${EMAIL}","password":"${PW}"}`,
      `{"email":"${EMAIL}"}`,
      `{"newPassword":"first password"}`,
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
});
