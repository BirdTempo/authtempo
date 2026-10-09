import { describe, expect, it } from "vitest";
import { defaultPasswordVerifyPage, defaultResetPage } from "../src/http/password-pages.js";

const base = {
  action: "/auth/password/reset",
  token: 'pr_x"<y',
  appName: "A<b>",
  minLength: 8,
  maxLength: 128,
};

describe("password pages", () => {
  it("escapes the app name and the token, and holds a form with no script", () => {
    const verify = defaultPasswordVerifyPage({
      action: "/auth/password/verify",
      token: 'pv_x"<y',
      appName: "A<b>",
    });
    expect(verify).toContain("<title>Confirm your email for A&lt;b&gt;</title>");
    expect(verify).toContain(`<form method="post" action="/auth/password/verify">`);
    expect(verify).toContain(`value="pv_x&quot;&lt;y"`);
    expect(verify).toContain("If you did not create an account");
    expect(verify).not.toContain("<script");
    const reset = defaultResetPage({ ...base, error: null });
    expect(reset).toContain("<title>Choose a new password for A&lt;b&gt;</title>");
    expect(reset).toContain(`<form method="post" action="/auth/password/reset">`);
    expect(reset).toContain(
      `name="password" minlength="8" maxlength="128" autocomplete="new-password" required`,
    );
    expect(reset).toContain(`value="pr_x&quot;&lt;y"`);
    expect(reset).not.toContain("<script");
    expect(reset).not.toContain(`class="error"`);
  });

  it("names the refusal on the reset page", () => {
    expect(defaultResetPage({ ...base, error: "password_policy" })).toContain(
      "Use 8 to 128 characters, no control characters, and not your email address.",
    );
    expect(defaultResetPage({ ...base, error: "password_breached" })).toContain(
      "This password is in a known data breach. Choose a different password.",
    );
  });
});
