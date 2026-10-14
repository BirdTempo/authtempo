import { describe, expect, it } from "vitest";
import { call, harness, lastMailTo } from "../support/harness.ts";
import { createPasswordAuth } from "./password.ts";

describe("sign in with a password", () => {
  it("signs up, mails the verify link, and signs in with the right password only", async () => {
    const h = harness();
    const auth = createPasswordAuth(h);
    const up = await call(auth, "POST", "/auth/password/sign-up", {
      email: "ada@example.com",
      password: "correct horse battery",
    });
    expect(up.status).toBe(200);
    const body = (await up.json()) as { token: string; user: { emailVerified: boolean } };
    expect(body.token.startsWith("ts_")).toBe(true);
    expect(body.user.emailVerified).toBe(false);
    expect(lastMailTo(h, "ada@example.com").subject).toBe("Confirm your email for api.example.com");

    const right = await call(auth, "POST", "/auth/password/sign-in", {
      email: "ada@example.com",
      password: "correct horse battery",
    });
    expect(right.status).toBe(200);
    const wrong = await call(auth, "POST", "/auth/password/sign-in", {
      email: "ada@example.com",
      password: "wrong horse battery",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
  });

  it("refuses a short password and a breached password", async () => {
    const auth = createPasswordAuth(harness());
    const short = await call(auth, "POST", "/auth/password/sign-up", {
      email: "bo@example.com",
      password: "short pw",
    });
    expect(await short.json()).toEqual({ error: "password_policy" });
    const breached = await call(auth, "POST", "/auth/password/sign-up", {
      email: "bo@example.com",
      password: "password1234",
    });
    expect(await breached.json()).toEqual({ error: "password_breached" });
  });
});
