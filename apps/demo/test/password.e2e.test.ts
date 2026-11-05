import { describe, expect, it } from "vitest";
import {
  call,
  lastLink,
  newSandbox,
  PASSWORD,
  SESSION_COOKIE,
  sameSandbox,
  verifiedUser,
  whoami,
} from "./helpers.js";

const EMAIL = "pat@example.com";

describe("password", () => {
  it("signs up, proves the address from the mailbox, and signs in", async () => {
    const jar = await newSandbox();
    const up = await call(jar, "POST", "/auth/password/sign-up", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(up.status).toBe(200);
    // The uniform answer carries the sign-up proof (ruling 11 of plan 12q).
    expect(await up.json()).toEqual({
      sent: true,
      signUpProof: expect.stringMatching(/^sp_[A-Za-z0-9_-]{43}$/),
    });
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(false);

    const link = await lastLink(jar, EMAIL);
    expect(link.pathname).toBe("/auth/password/verify");
    expect(link.searchParams.get("token")).toMatch(/^pv_/);
    const page = await call(jar, "GET", `${link.pathname}${link.search}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`<form method="post" action="/auth/password/verify">`);
    const verified = await call(
      jar,
      "POST",
      "/auth/password/verify",
      new URLSearchParams({ token: link.searchParams.get("token") ?? "" }),
    );
    expect(verified.status).toBe(302);
    expect(await whoami(jar)).toMatchObject({ kind: "session", email: EMAIL });

    // A second visitor of the sandbox signs in with the password.
    const other = sameSandbox(jar);
    const wrong = await call(other, "POST", "/auth/password/sign-in", {
      email: EMAIL,
      password: "wrong password",
    });
    expect(wrong.status).toBe(401);
    const signIn = await call(other, "POST", "/auth/password/sign-in", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    expect(await whoami(other)).toMatchObject({ kind: "session", email: EMAIL });
  });

  it("resets the password by the link of the mailbox", async () => {
    const jar = await newSandbox();
    await verifiedUser(jar, EMAIL);
    const other = sameSandbox(jar);
    expect(
      (await call(other, "POST", "/auth/password/reset/request", { email: EMAIL })).status,
    ).toBe(200);
    const link = await lastLink(other, EMAIL);
    expect(link.pathname).toBe("/auth/password/reset");
    expect(link.searchParams.get("token")).toMatch(/^pr_/);
    expect((await call(other, "GET", `${link.pathname}${link.search}`)).status).toBe(200);
    const reset = await call(
      other,
      "POST",
      "/auth/password/reset",
      new URLSearchParams({
        token: link.searchParams.get("token") ?? "",
        password: "new horse battery staple",
      }),
    );
    expect(reset.status).toBe(302);
    // The reset ends the earlier session.
    expect(await whoami(jar)).toBeNull();
    const old = await call(sameSandbox(jar), "POST", "/auth/password/sign-in", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(old.status).toBe(401);
    const fresh = sameSandbox(jar);
    const signIn = await call(fresh, "POST", "/auth/password/sign-in", {
      email: EMAIL,
      password: "new horse battery staple",
    });
    expect(signIn.status).toBe(200);
    expect(await whoami(fresh)).toMatchObject({ email: EMAIL });
  });
});
