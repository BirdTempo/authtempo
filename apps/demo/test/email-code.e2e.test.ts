import { describe, expect, it } from "vitest";
import { call, lastCode, newSandbox, PASSWORD, sameSandbox, whoami } from "./helpers.js";

describe("email code", () => {
  it("signs in with the code of the mailbox", async () => {
    const jar = await newSandbox();
    const email = "otp-ada@example.com";
    expect((await call(jar, "POST", "/auth/otp/request", { email })).status).toBe(200);
    const code = await lastCode(jar, email);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await call(jar, "POST", "/auth/otp/verify", {
      email,
      code: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(400);
    const verify = await call(jar, "POST", "/auth/otp/verify", { email, code });
    expect(verify.status).toBe(200);
    expect(await whoami(jar)).toMatchObject({ kind: "session", email });
  });

  it("resets the password by a code", async () => {
    const jar = await newSandbox();
    const email = "otp-pat@example.com";
    expect(
      (await call(jar, "POST", "/auth/password/sign-up", { email, password: PASSWORD })).status,
    ).toBe(200);
    expect((await call(jar, "POST", "/auth/otp/reset/request", { email })).status).toBe(200);
    const code = await lastCode(jar, email);
    const reset = await call(jar, "POST", "/auth/otp/reset", {
      email,
      code,
      password: "a new long password",
    });
    expect(reset.status).toBe(200);
    expect(await whoami(jar)).toMatchObject({ email });

    const old = await call(sameSandbox(jar), "POST", "/auth/password/sign-in", {
      email,
      password: PASSWORD,
    });
    expect(old.status).toBe(401);
    const fresh = sameSandbox(jar);
    const signIn = await call(fresh, "POST", "/auth/password/sign-in", {
      email,
      password: "a new long password",
    });
    expect(signIn.status).toBe(200);
    expect(await whoami(fresh)).toMatchObject({ email });
  });
});
